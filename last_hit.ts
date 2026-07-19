import {
	Ability,
	Color,
	Creep,
	DOTA_ABILITY_BEHAVIOR,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	InputManager,
	LocalPlayer,
	Menu,
	ParticleAttachment,
	ParticlesSDK,
	ProjectileManager,
	TickSleeper,
	Tower,
	Unit
} from "github.com/octarine-public/wrapper/index"

const lastHitSleeper = new TickSleeper()

// Track the last attack target to avoid self-canceling
let lastAttackTargetIdx = -1
let lastAttackOrderTime = 0

function sleepTime(hero?: Hero): number {
	const base = Math.randomRange(GameState.InputLag, GameState.InputLag + 1 / 60) * 1000
	// If hero is in attack animation, sleep at least until animation completes
	// to prevent canceling our own attack. Add ~30ms buffer for ping variance.
	if (hero && hero.IsInAnimation && hero.LastAnimationIsAttack && !hero.LastAnimationCasted) {
		const remainingMs = Math.max(
			0,
			(hero.LastAnimationStartTime + hero.LastAnimationCastPoint - GameState.RawServerTime) * 1000 + 30
		)
		return Math.max(base + 50, remainingMs)
	}
	return base + 50
}

class CustomLastHit {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Custom Last Hit")

	private readonly enabled = this.entry.AddToggle("Enable Script", true, "Toggle to enable/disable auto last hit")
	private readonly lastHitKey = this.entry.AddKeybind(
		"Hold Key",
		"Space",
		"Hold to auto last hit and deny"
	)
	private readonly spellsKey = this.entry.AddKeybind(
		"Spells Key",
		"None",
		"Hold to auto last hit using spells"
	)
	private readonly denyEnabled = this.entry.AddToggle("Deny Friendly Creeps", true)
	private readonly prioritySetting = this.entry.AddDropdown(
		"Action Priority",
		["Last Hit", "Deny"],
		0,
		"Select which action to prioritize (LastHit = prioritize last hit, Deny = prioritize deny when both are possible)"
	)
	private readonly spellsEnabled = this.entry.AddToggle("Use Spells for Last Hit", false)
	private readonly showAttackRange = this.entry.AddToggle("Show Attack Range", false)
	private readonly followCursor = this.entry.AddToggle(
		"Follow Mouse Cursor",
		true,
		"Move to mouse position when holding key and idle"
	)

	private readonly harassNode = this.entry.AddNode("Harass Options")
	private readonly harassEnabled = this.harassNode.AddToggle("Harass Enemy Heroes", true)
	private readonly aggressiveHarass = this.harassNode.AddToggle(
		"Aggressive Harass (Ignore aggro/tower)",
		false
	)
	private readonly harassSearchRadius = this.harassNode.AddSlider(
		"Harass Search Radius",
		800,
		300,
		1500
	)

	private readonly pSDK = new ParticlesSDK()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private onGameEnded(): void {
		lastHitSleeper.Sleep(0)
		this.pSDK.DestroyAll()
	}

	/**
	 * Calculate when our hero's attack projectile will land on the creep.
	 * Accounts for: turn time, attack point (windup), and projectile travel time for ranged heroes.
	 */
	private getHeroAttackLandTime(hero: Hero, creep: Creep): number {
		const now = GameState.RawServerTime
		const turnTime = hero.TurnTimeNew(creep.Position, false)

		// GetNextAttackPoint accounts for current animation state and input lag
		const attackPoint = hero.GetNextAttackPoint(GameState.InputLag)

		// Projectile travel time (0 for melee)
		let travelTime = 0
		if (hero.IsRanged) {
			const dist = hero.Distance2D(creep)
			const speed =
				hero.AttackProjectileSpeed > 0 ? hero.AttackProjectileSpeed : 1000
			travelTime = Math.max(0, dist / speed)
		}

		return now + GameState.InputLag + turnTime + attackPoint + travelTime
	}

	/**
	 * Calculate when the nearest enemy hero could land an attack on this creep.
	 * Returns { landTime, attackDamage } or null if no enemy hero is in range.
	 * Used to determine if we're racing an enemy for the last hit.
	 */
	private getFastestEnemyLastHit(hero: Hero, creep: Creep): { landTime: number, attackDamage: number, hero: Hero } | null {
		const now = GameState.RawServerTime
		let best: { landTime: number, attackDamage: number, hero: Hero } | null = null

		const allHeroes = EntityManager.GetEntitiesByClass(Hero)
		for (const enemy of allHeroes) {
			if (
				!enemy.IsValid ||
				!enemy.IsAlive ||
				!enemy.IsVisible ||
				!enemy.IsEnemy(hero) ||
				enemy.IsIllusion ||
				enemy.IsDisarmed
			) {
				continue
			}

			const attackRange = enemy.GetAttackRange(creep)
			const dist = enemy.Distance2D(creep)
			if (dist > attackRange + enemy.HullRadius + creep.HullRadius + 100) {
				continue
			}

			const turnTime = enemy.TurnTimeNew(creep.Position, false)
			const attackPoint = enemy.GetNextAttackPoint(GameState.InputLag)
			let travelTime = 0
			if (enemy.IsRanged) {
				const speed = enemy.AttackProjectileSpeed > 0 ? enemy.AttackProjectileSpeed : 1000
				travelTime = dist / speed
			}

			const landTime = now + turnTime + attackPoint + travelTime
			const attackDamage = enemy.GetAttackDamage(creep)

			if (!best || landTime < best.landTime) {
				best = { landTime, attackDamage, hero: enemy }
			}
		}

		return best
	}

	/**
	 * Predict the creep's HP at the given landTime by simulating:
	 * 1. In-flight tracking projectiles
	 * 2. Future attacks from units (creeps, heroes) currently targeting the creep
	 * 3. Tower attacks (separate entity, multi-attack projection)
	 */
	private predictCreepHealth(hero: Hero, creep: Creep, landTime: number): number {
		const now = GameState.RawServerTime
		let predictedHP = creep.HP

		// Natural HP regeneration during the prediction window
		if (landTime > now) {
			predictedHP += (creep.HPRegen || 0) * (landTime - now)
		}

		// 1. Simulate all in-flight projectiles targeting this creep
		const projectiles = ProjectileManager.AllTrackingProjectiles
		for (const proj of projectiles) {
			if (
				!proj.IsValid ||
				proj.IsDodged ||
				!proj.Target ||
				proj.Target.Index !== creep.Index
			) {
				continue
			}
			const source = proj.Source
			if (
				!source ||
				!(source instanceof Unit) ||
				!source.IsValid ||
				source.Index === hero.Index
			) {
				continue
			}

			const dist = creep.Distance2D(proj.Position)
			const speed = proj.Speed > 0 ? proj.Speed : 1000
			const timeToImpact = dist / speed
			const projLandTime = now + timeToImpact

			if (projLandTime <= landTime) {
				const damage = source.GetAttackDamage(creep)
				predictedHP -= damage
				// Creep dies before our attack lands — stop simulating
				if (predictedHP <= 0) {
					return 0
				}
			}
		}

		// 2. Simulate future attacks from units (creeps, heroes) targeting this creep
		const allUnits = EntityManager.GetEntitiesByClass(Unit)
		for (const unit of allUnits) {
			if (
				!unit.IsValid ||
				!unit.IsAlive ||
				!unit.IsVisible ||
				unit.Index === hero.Index ||
				unit.IsDisarmed ||
				!unit.IsEnemy(creep)
			) {
				continue
			}

			// Only consider units currently targeting this creep
			const currentTarget = unit.Target
			if (!currentTarget || currentTarget.Index !== creep.Index) {
				continue
			}

			// Check if unit is in range to attack this creep
			const attackRange = unit.GetAttackRange(creep)
			if (unit.Distance2D(creep) > attackRange + 50) {
				continue
			}

			// Determine when the unit's next attack will fire
			let nextFireTime: number
			if (
				unit.IsInAnimation &&
				unit.LastAnimationIsAttack &&
				!unit.LastAnimationCasted
			) {
				const remaining =
					unit.LastAnimationStartTime + unit.LastAnimationCastPoint - now
				nextFireTime = now + Math.max(0, remaining)
			} else {
				const attackCooldown = Math.max(
					unit.AttackTimeAtLastTick + unit.SecondsPerAttack,
					now + unit.GetNextAttackPoint(0)
				)
				nextFireTime = attackCooldown
			}

			const unitTravelTime = unit.IsRanged
				? unit.Distance2D(creep) /
					(unit.AttackProjectileSpeed > 0 ? unit.AttackProjectileSpeed : 1000)
				: 0

			// Only project the next single attack — multi-attack projection
			// over-estimates damage and causes false negatives
			const currentLandTime = nextFireTime + unitTravelTime
			if (currentLandTime <= landTime) {
				const damage = unit.GetAttackDamage(creep)
				predictedHP -= damage
				if (predictedHP <= 0) {
					return 0
				}
			}
		}

		// 3. Simulate tower attacks (Tower is a separate entity class from Unit)
		// Towers are very predictable, so we can safely project multiple attacks
		const towers = EntityManager.GetEntitiesByClass(Tower)
		for (const tower of towers) {
			if (!tower.IsValid || !tower.IsAlive || !tower.IsVisible || !tower.IsEnemy(creep)) {
				continue
			}

			const currentTarget = tower.Target
			if (!currentTarget || currentTarget.Index !== creep.Index) {
				continue
			}

			const towerAttackRange = tower.GetAttackRange(creep)
			if (tower.Distance2D(creep) > towerAttackRange + 50) {
				continue
			}

			let nextFireTime: number
			if (
				tower.IsInAnimation &&
				tower.LastAnimationIsAttack &&
				!tower.LastAnimationCasted
			) {
				const remaining =
					tower.LastAnimationStartTime + tower.LastAnimationCastPoint - now
				nextFireTime = now + Math.max(0, remaining)
			} else {
				const attackCooldown = Math.max(
					tower.AttackTimeAtLastTick + tower.SecondsPerAttack,
					now + tower.GetNextAttackPoint(0)
				)
				nextFireTime = attackCooldown
			}

			const towerTravelTime = tower.IsRanged
				? tower.Distance2D(creep) /
					(tower.AttackProjectileSpeed > 0 ? tower.AttackProjectileSpeed : 1000)
				: 0

			const secondsPerAttack = Math.max(0.5, tower.SecondsPerAttack || 1.0)

			// Project multiple tower attacks — towers are predictable and hit hard,
			// so we need the full sequence to time our last hit correctly
			let currentLandTime = nextFireTime + towerTravelTime
			while (currentLandTime <= landTime) {
				const damage = tower.GetAttackDamage(creep)
				predictedHP -= damage
				if (predictedHP <= 0) {
					return 0
				}
				currentLandTime += secondsPerAttack
			}
		}

		return Math.max(0, predictedHP)
	}

	/**
	 * Sums ALL incoming attack damage currently heading toward this creep from
	 * towers AND allied creeps that are actively targeting it. Used for pre-hit
	 * adjustment to account for combined creep + tower damage.
	 */
	private getCurrentIncomingDamage(hero: Hero, creep: Creep): number {
		let total = 0

		// Tower damage
		const towers = EntityManager.GetEntitiesByClass(Tower)
		for (const tower of towers) {
			if (!tower.IsValid || !tower.IsAlive || !tower.IsVisible || !tower.IsEnemy(creep)) {
				continue
			}
			const target = tower.Target
			if (target && target.Index === creep.Index) {
				total += tower.GetAttackDamage(creep)
			}
		}

		// Allied units (creeps) currently targeting this creep
		const allUnits = EntityManager.GetEntitiesByClass(Unit)
		for (const unit of allUnits) {
			if (
				!unit.IsValid ||
				!unit.IsAlive ||
				!unit.IsVisible ||
				unit.Index === hero.Index ||
				unit.IsDisarmed ||
				!unit.IsEnemy(creep)
			) {
				continue
			}
			const currentTarget = unit.Target
			if (currentTarget && currentTarget.Index === creep.Index) {
				const attackRange = unit.GetAttackRange(creep)
				if (unit.Distance2D(creep) <= attackRange + 50) {
					total += unit.GetAttackDamage(creep)
				}
			}
		}

		return total
	}

	private updateAttackRangeDraw(hero: Hero): void {
		const isKeyPressed = this.lastHitKey.isPressed || this.spellsKey.isPressed
		if (this.showAttackRange.value && isKeyPressed && hero.IsValid && hero.IsAlive) {
			const attackRange = hero.GetAttackRange(undefined, 0, false)
			this.pSDK.DrawCircle("hero_attack_range", hero, attackRange, {
				Color: Color.Green,
				Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
			})
		} else {
			this.pSDK.DestroyByKey("hero_attack_range")
		}
	}

	/**
	 * Check if there's another creep that's about to be killable in the next
	 * ~0.5 seconds. If so, we should NOT pre-hit — save our attack for the real kill.
	 */
	private hasCreepNearKillRange(
		hero: Hero,
		creeps: Creep[],
		skipCreep: Creep,
		attackRange: number,
		effectiveRange: number
	): boolean {
		const now = GameState.RawServerTime
		for (const c of creeps) {
			if (c.Index === skipCreep.Index || !c.IsEnemy(hero)) {
				continue
			}
			const dist = hero.Distance2D(c)
			if (dist > effectiveRange + 200) {
				continue
			}
			const landTime = this.getHeroAttackLandTime(hero, c)
			if (landTime > now + 0.5) {
				continue
			}
			const predicted = this.predictCreepHealth(hero, c, landTime)
			const dmg = hero.GetAttackDamage(c) * 0.92
			if (predicted > 0 && predicted <= dmg) {
				return true
			}
		}
		return false
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || ExecuteOrder.DisableHumanizer) {
			return
		}

		if (!this.enabled.value) {
			this.pSDK.DestroyByKey("hero_attack_range")
			return
		}

		const player = LocalPlayer
		if (!player) {
			return
		}
		const hero = player.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.pSDK.DestroyByKey("hero_attack_range")
			return
		}

		this.updateAttackRangeDraw(hero)

		const isLastHitKeyPressed = this.lastHitKey.isPressed
		const isSpellsKeyPressed = this.spellsKey.isPressed

		if (!isLastHitKeyPressed && !isSpellsKeyPressed) {
			return
		}

		if (lastHitSleeper.Sleeping) {
			return
		}

		// Don't issue a new order if we're mid-attack-animation and
		// still targeting the same creep — prevents self-canceling
		if (
			hero.IsInAnimation &&
			hero.LastAnimationIsAttack &&
			!hero.LastAnimationCasted &&
			lastAttackTargetIdx >= 0 &&
			hero.Target &&
			hero.Target.Index === lastAttackTargetIdx
		) {
			return
		}

		// If we just issued an attack order, let the projectile land before re-evaluating.
		// The sleeper alone isn't enough because animation resets on move/cancel.
		if (
			lastAttackOrderTime > 0 &&
			GameState.RawServerTime * 1000 - lastAttackOrderTime <
			hero.GetNextAttackPoint(GameState.InputLag) * 1000 + 30
		) {
			return
		}

		if (
			hero.IsChanneling ||
			hero.IsStunned ||
			hero.IsSilenced ||
			hero.IsHexed ||
			hero.IsInvisible
		) {
			return
		}

		const heroAttackRange = hero.GetAttackRange(undefined, 0, false)
		const searchRadius = heroAttackRange + 300

		const creeps = EntityManager.GetEntitiesByClass(Creep).filter(
			c => c.IsValid && c.IsAlive && c.IsVisible && hero.Distance2D(c) <= searchRadius
		)

		// --- Last hit / Deny with attacks (only when lastHitKey is pressed) ---
		if (isLastHitKeyPressed) {
			interface ScoreEntry {
				creep: Creep
				margin: number
				isDeny: boolean
				isPrepHit: boolean
			}
			const candidates: ScoreEntry[] = []

			const canAttack = hero.CanAttack()

			if (canAttack) {
				for (const creep of creeps) {
					const creepDist = hero.Distance2D(creep)
					const effectiveRange = heroAttackRange + hero.HullRadius + creep.HullRadius + 50

					const landTime = this.getHeroAttackLandTime(hero, creep)
					const predictedHP = this.predictCreepHealth(hero, creep, landTime)
					const attackDamage = hero.GetAttackDamage(creep)
					const safeDamage = attackDamage * 0.92

					// Enemy race detection — conservative: use 85% of enemy damage
					const enemyHit = this.getFastestEnemyLastHit(hero, creep)
					const enemyWinsRace =
						enemyHit !== null &&
						enemyHit.landTime < landTime &&
						predictedHP > 0 &&
						predictedHP <= enemyHit.attackDamage * 0.85

					// Enemy creep — last hit
					if (creep.IsEnemy(hero)) {
						// Main prediction — use safeDamage to account for damage roll variance
						if (predictedHP > 0 && predictedHP <= safeDamage && !enemyWinsRace) {
							candidates.push({
								creep,
								margin: attackDamage - predictedHP + (creepDist > effectiveRange ? 500 : 0),
								isDeny: false,
								isPrepHit: false
							})
						}
						// We're slightly too slow, but pre-hitting now spoils the enemy's last hit
						// and sets HP for our next attack
						else if (
							enemyWinsRace &&
							creepDist <= effectiveRange &&
							enemyHit !== null // TypeScript narrowing
						) {
							const afterOurHit = creep.HP - attackDamage
							const enemyLandHP = afterOurHit - enemyHit.attackDamage
							// After our pre-hit + enemy hit, HP must still be >0 AND killable by us
							if (afterOurHit > 0 && enemyLandHP > 0 && enemyLandHP <= safeDamage) {
								candidates.push({
									creep,
									margin: 1500 + (attackDamage - enemyLandHP),
									isDeny: false,
									isPrepHit: true
								})
							}
						}
						// Safety net: over-prediction fallback
						else if (predictedHP <= 0 && creep.HP > 0 && creep.HP <= safeDamage && !enemyWinsRace) {
							candidates.push({
								creep,
								margin: attackDamage - creep.HP + (creepDist > effectiveRange ? 500 : 0),
								isDeny: false,
								isPrepHit: false
							})
						}
						// Pre-hit setup: must be in range, otherwise hero stutters with follow cursor.
						// Hit early to bring creep HP into killable range for our next attack.
						// Only pre-hit when the creep is barely above kill threshold (≤20% over),
						// to avoid wasting attack cooldown on non-urgent creeps.
						else if (creepDist <= effectiveRange && predictedHP > safeDamage && predictedHP <= safeDamage * 1.2) {
							const afterOurHit = creep.HP - attackDamage
							const incomingDamage = this.getCurrentIncomingDamage(hero, creep)
							const afterPreHitPlusWave = afterOurHit - incomingDamage

							// Case A: Pre-hit + incoming damage wave sets HP into kill range
							if (incomingDamage > 0 && afterPreHitPlusWave > 0 && afterPreHitPlusWave <= safeDamage) {
								candidates.push({
									creep,
									margin: 1000 + (attackDamage - afterPreHitPlusWave) + (enemyWinsRace ? 500 : 0),
									isDeny: false,
									isPrepHit: true
								})
							}
							// Case B: No wave, but our hit alone brings it into kill range on next attack.
							// Only trigger if there's NO other creep that will be killable very soon
							// (to avoid wasting attack cooldown and missing a real last hit).
							else if (afterOurHit > 0 && afterOurHit <= safeDamage && !this.hasCreepNearKillRange(hero, creeps, creep, heroAttackRange, effectiveRange)) {
								candidates.push({
									creep,
									margin: 2500 + (attackDamage - afterOurHit) * 0.5,
									isDeny: false,
									isPrepHit: true
								})
							}
						}
					}
					// Friendly creep — deny
					else if (
						this.denyEnabled.value &&
						creep.IsDeniable &&
						creep.HP / creep.MaxHP < 0.5
					) {
						if (predictedHP > 0 && predictedHP <= safeDamage) {
							candidates.push({
								creep,
								margin: attackDamage - predictedHP + (creepDist > effectiveRange ? 500 : 0),
								isDeny: true,
								isPrepHit: false
							})
						} else if (predictedHP <= 0 && creep.HP > 0 && creep.HP <= safeDamage) {
							candidates.push({
								creep,
								margin: attackDamage - creep.HP + (creepDist > effectiveRange ? 500 : 0),
								isDeny: true,
								isPrepHit: false
							})
						}
					}
				}
			}

			if (candidates.length > 0) {
				// Sort by priority then by margin
				// Priority 0 = Last Hit first, 1 = Deny first
				const prioritizeDeny = this.prioritySetting.SelectedID === 1

				candidates.sort((a, b) => {
					// Primary sort: real last hits before prep hits
					if (a.isPrepHit !== b.isPrepHit) {
						return a.isPrepHit ? 1 : -1
					}
					// Secondary sort: by priority (deny preference)
					if (a.isDeny !== b.isDeny && !a.isPrepHit) {
						return prioritizeDeny
							? a.isDeny
								? -1
								: 1
							: a.isDeny
								? 1
								: -1
					}
					// Tertiary sort: by margin (smaller = more urgent)
					return a.margin - b.margin
				})

				const best = candidates[0]
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
					issuers: [hero],
					target: best.creep.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastAttackTargetIdx = best.creep.Index
				lastAttackOrderTime = GameState.RawServerTime * 1000
				lastHitSleeper.Sleep(sleepTime(hero))
				return
			}
		}

		// --- Spell last hit (when spellsKey is pressed or toggle is on) ---
		if ((isSpellsKeyPressed || this.spellsEnabled.value) && !hero.IsSilenced) {
			const usableSpells = hero.Spells.filter((s): s is Ability => {
				if (!s || !s.IsValid || s.IsHidden || s.IsItem || !s.CanBeCasted()) {
					return false
				}
				if (s.IsPassive) {
					return false
				}
				// Exclude ultimate (slot 3), exclude slot 4+ (bonus abilities)
				if (s.AbilitySlot !== undefined && (s.AbilitySlot === 3 || s.AbilitySlot > 3)) {
					return false
				}
				return true
			})

			let bestSpellCombo:
				| { creep: Creep; spell: Ability; margin: number }
				| undefined

			for (const creep of creeps) {
				if (!creep.IsEnemy(hero)) {
					continue
				}
				for (const spell of usableSpells) {
					// Skip spells that are out of range
					const castRange = spell.CastRange
					if (castRange > 0 && hero.Distance2D(creep) > castRange) {
						continue
					}

					const spellLandTime =
						GameState.RawServerTime +
						GameState.InputLag +
						hero.TurnTimeNew(creep.Position, false) +
						spell.CastPoint

					const predictedSpellHP = this.predictCreepHealth(hero, creep, spellLandTime)
					const spellDamage = spell.GetDamage(creep)
					const safeSpellDamage = spellDamage * 0.92

					if (predictedSpellHP > 0 && predictedSpellHP <= safeSpellDamage) {
						const margin = spellDamage - predictedSpellHP
						if (!bestSpellCombo || margin < bestSpellCombo.margin) {
							bestSpellCombo = { creep, spell, margin }
						}
					}
					// Safety net: over-prediction fallback
					else if (predictedSpellHP <= 0 && creep.HP > 0 && creep.HP <= safeSpellDamage) {
						const margin = spellDamage - creep.HP
						if (!bestSpellCombo || margin < bestSpellCombo.margin) {
							bestSpellCombo = { creep, spell, margin }
						}
					}
				}
			}

			if (bestSpellCombo) {
				const { creep, spell } = bestSpellCombo

				if (
					spell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)
				) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: spell.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				} else if (
					spell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)
				) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: creep.Position,
						ability: spell.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				} else if (
					spell.HasBehavior(
						DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET
					)
				) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: creep.Index,
						ability: spell.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
				lastAttackTargetIdx = best.creep.Index
				lastAttackOrderTime = GameState.RawServerTime * 1000
				lastHitSleeper.Sleep(sleepTime(hero) + spell.CastPoint * 1000)
				return
			}
		}

		// --- Harass (only when lastHitKey pressed and no last hit / deny / spell target found) ---
		if (
			isLastHitKeyPressed &&
			this.harassEnabled.value &&
			!hero.IsDisarmed &&
			hero.CanAttack()
		) {
			const inEnemyTowerRange = EntityManager.GetEntitiesByClass(Tower).some(
				t =>
					t.IsValid &&
					t.IsAlive &&
					t.IsEnemy(hero) &&
					hero.Position.Distance2D(t.Position) <= t.GetAttackRange(hero)
			)

			const nearEnemyCreeps = EntityManager.GetEntitiesByClass(Creep).some(
				c =>
					c.IsValid &&
					c.IsAlive &&
					c.IsEnemy(hero) &&
					hero.Position.Distance2D(c.Position) <= 500
			)

			const safeToHarass =
				this.aggressiveHarass.value || (!inEnemyTowerRange && !nearEnemyCreeps)

			if (safeToHarass) {
				let bestHarassTarget: Hero | undefined
				let minDist = Infinity

				const heroes = EntityManager.GetEntitiesByClass(Hero)
				for (const enemy of heroes) {
					if (
						enemy.IsValid &&
						enemy.IsAlive &&
						enemy.IsVisible &&
						enemy.IsEnemy(hero) &&
						!enemy.IsIllusion
					) {
						const dist = hero.Distance2D(enemy)
						if (
							dist <= this.harassSearchRadius.value &&
							dist < minDist
						) {
							minDist = dist
							bestHarassTarget = enemy
						}
					}
				}

				if (bestHarassTarget) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
						issuers: [hero],
						target: bestHarassTarget.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					lastAttackTargetIdx = bestHarassTarget.Index
					lastAttackOrderTime = GameState.RawServerTime * 1000
					lastHitSleeper.Sleep(sleepTime(hero))
					return
				}
			}
		}

		// --- Follow cursor (only when lastHitKey pressed and idle) ---
		if (isLastHitKeyPressed && this.followCursor.value) {
			const mousePos = InputManager.CursorOnWorld
			if (mousePos && mousePos.IsValid) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
					issuers: [hero],
					position: mousePos,
					queue: false,
					showEffects: false,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(sleepTime(hero))
			}
		}
	}
}

new CustomLastHit()
