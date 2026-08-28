import {
	Ability,
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
	ProjectileManager,
	TickSleeper,
	Tower,
	Unit
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"

const lastHitSleeper = new TickSleeper()

// Track the last attack target to avoid self-canceling
let lastAttackTargetIdx = -1
let lastAttackOrderTime = 0
let lastDeAggroTime = 0

function sleepTime(hero?: Hero): number {
	const base = Math.randomRange(GameState.InputLag, GameState.InputLag + 1 / 60) * 1000
	// If hero is mid-attack windup (before projectile is fired), sleep until windup completes
	if (hero && hero.IsInAnimation && hero.LastAnimationIsAttack && !hero.LastAnimationCasted) {
		const remainingMs = Math.max(
			0,
			(hero.LastAnimationStartTime + hero.LastAnimationCastPoint - GameState.RawServerTime) * 1000 + 20
		)
		return Math.max(base + 30, remainingMs)
	}
	return base + 30
}

class CustomLastHit {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Custom Last Hit")

	private readonly enabled = this.entry.AddToggle("Enable Script", true, "Toggle to enable/disable auto last hit")
	private readonly lastHitKey = this.entry.AddKeybind(
		"Hold Key",
		"Space",
		"Hold to auto last hit, deny, and smart orbwalk"
	)
	private readonly spellsKey = this.entry.AddKeybind("Spells Key", "None", "Hold to auto last hit using spells")
	private readonly denyEnabled = this.entry.AddToggle("Deny Friendly Creeps", true)
	private readonly prioritySetting = this.entry.AddDropdown(
		"Action Priority",
		["Last Hit", "Deny"],
		0,
		"Select which action to prioritize when both are possible"
	)
	private readonly spellsEnabled = this.entry.AddToggle("Use Spells for Last Hit", false)
	private readonly cancelBackswing = this.entry.AddToggle(
		"Cancel Backswing (Smooth Orbwalk)",
		true,
		"Instantly cancel backswing animation after attack projectile is released to move freely"
	)
	private readonly towerHelper = this.entry.AddToggle(
		"Under-Tower Helper (Smart Prep-Hit)",
		true,
		"Prepare creeps under tower with smart prep-hits so tower does not steal the kill"
	)
	private readonly followCursor = this.entry.AddToggle(
		"Follow Mouse Cursor",
		true,
		"Move to mouse position when holding key and idle"
	)

	// Harass & Aggro Settings
	private readonly harassNode = this.entry.AddNode("Harass & Aggro Control")
	private readonly harassEnabled = this.harassNode.AddToggle("Harass Enemy Heroes", true)
	private readonly aggressiveHarass = this.harassNode.AddToggle("Aggressive Harass (Ignore aggro/tower)", false)
	private readonly autoDeAggro = this.harassNode.AddToggle(
		"Auto De-Aggro Creeps",
		true,
		"Automatically right-click friendly creep to drop enemy creep aggro when attacked"
	)
	private readonly harassSearchRadius = this.harassNode.AddSlider("Harass Search Radius", 800, 300, 1500)

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private onGameEnded(): void {
		lastHitSleeper.Sleep(0)
		lastAttackTargetIdx = -1
		lastAttackOrderTime = 0
		lastDeAggroTime = 0
	}

	/**
	 * Calculate when our hero's attack projectile will land on the creep.
	 * Accounts for: turn time, attack point (windup), and projectile travel time for ranged heroes.
	 */
	private getHeroAttackLandTime(hero: Hero, creep: Creep): number {
		const now = GameState.RawServerTime
		const turnTime = hero.TurnTimeNew(creep.Position, false)
		const attackPoint = hero.GetNextAttackPoint(GameState.InputLag)

		let travelTime = 0
		if (hero.IsRanged) {
			const dist = hero.Distance2D(creep)
			const speed = hero.AttackProjectileSpeed > 0 ? hero.AttackProjectileSpeed : 1000
			travelTime = Math.max(0, dist / speed)
		}

		return now + GameState.InputLag + turnTime + attackPoint + travelTime
	}

	/**
	 * Calculate when the nearest enemy hero could land an attack on this creep.
	 */
	private getFastestEnemyLastHit(
		hero: Hero,
		creep: Creep
	): { landTime: number; attackDamage: number; hero: Hero } | null {
		const now = GameState.RawServerTime
		let best: { landTime: number; attackDamage: number; hero: Hero } | null = null

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
	 * Predict the creep's HP at the given landTime by simulating in-flight projectiles,
	 * future attacks from units currently targeting the creep, and towers.
	 */
	private predictCreepHealth(hero: Hero, creep: Creep, landTime: number): number {
		const now = GameState.RawServerTime
		let predictedHP = creep.HP

		if (landTime > now) {
			predictedHP += (creep.HPRegen || 0) * (landTime - now)
		}

		// 1. Simulate in-flight tracking projectiles
		const projectiles = ProjectileManager.AllTrackingProjectiles
		for (const proj of projectiles) {
			if (!proj.IsValid || proj.IsDodged || !proj.Target || proj.Target.Index !== creep.Index) {
				continue
			}
			const source = proj.Source
			if (!source || !(source instanceof Unit) || !source.IsValid || source.Index === hero.Index) {
				continue
			}

			const dist = creep.Distance2D(proj.Position)
			const speed = proj.Speed > 0 ? proj.Speed : 1000
			const timeToImpact = dist / speed
			const projLandTime = now + timeToImpact

			if (projLandTime <= landTime) {
				const damage = source.GetAttackDamage(creep)
				predictedHP -= damage
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

			const currentTarget = unit.Target
			if (!currentTarget || currentTarget.Index !== creep.Index) {
				continue
			}

			const attackRange = unit.GetAttackRange(creep)
			if (unit.Distance2D(creep) > attackRange + 50) {
				continue
			}

			let nextFireTime: number
			if (unit.IsInAnimation && unit.LastAnimationIsAttack && !unit.LastAnimationCasted) {
				const remaining = unit.LastAnimationStartTime + unit.LastAnimationCastPoint - now
				nextFireTime = now + Math.max(0, remaining)
			} else {
				const attackCooldown = Math.max(
					unit.AttackTimeAtLastTick + unit.SecondsPerAttack,
					now + unit.GetNextAttackPoint(0)
				)
				nextFireTime = attackCooldown
			}

			const unitTravelTime = unit.IsRanged
				? unit.Distance2D(creep) / (unit.AttackProjectileSpeed > 0 ? unit.AttackProjectileSpeed : 1000)
				: 0

			const currentLandTime = nextFireTime + unitTravelTime
			if (currentLandTime <= landTime) {
				const damage = unit.GetAttackDamage(creep)
				predictedHP -= damage
				if (predictedHP <= 0) {
					return 0
				}
			}
		}

		// 3. Simulate tower attacks
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
			if (tower.IsInAnimation && tower.LastAnimationIsAttack && !tower.LastAnimationCasted) {
				const remaining = tower.LastAnimationStartTime + tower.LastAnimationCastPoint - now
				nextFireTime = now + Math.max(0, remaining)
			} else {
				const attackCooldown = Math.max(
					tower.AttackTimeAtLastTick + tower.SecondsPerAttack,
					now + tower.GetNextAttackPoint(0)
				)
				nextFireTime = attackCooldown
			}

			const towerTravelTime = tower.IsRanged
				? tower.Distance2D(creep) / (tower.AttackProjectileSpeed > 0 ? tower.AttackProjectileSpeed : 1000)
				: 0

			const secondsPerAttack = Math.max(0.5, tower.SecondsPerAttack || 1.0)
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

	private getCurrentIncomingDamage(hero: Hero, creep: Creep): number {
		let total = 0

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

	private hasCreepNearKillRange(
		hero: Hero,
		creeps: Creep[],
		skipCreep: Creep,
		_attackRange: number,
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

	/**
	 * De-aggro mechanism: right click friendly creep to shed enemy creep aggro.
	 */
	private handleDeAggro(hero: Hero): boolean {
		const now = GameState.RawServerTime
		if (now - lastDeAggroTime < 2.0) {
			return false
		}

		// Check if any enemy creep is currently aggroed onto our hero
		const creeps = EntityManager.GetEntitiesByClass(Creep)
		const aggroedCreep = creeps.find(
			c =>
				c.IsValid && c.IsAlive && c.IsEnemy(hero) && c.Target?.Index === hero.Index && hero.Distance2D(c) <= 600
		)

		if (!aggroedCreep) {
			return false
		}

		// Find nearest allied creep to target for de-aggro
		const alliedCreep = creeps.find(c => c.IsValid && c.IsAlive && !c.IsEnemy(hero) && hero.Distance2D(c) <= 1000)

		if (alliedCreep) {
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
				issuers: [hero],
				target: alliedCreep.Index,
				queue: false,
				showEffects: false,
				isPlayerInput: false
			})
			claimOrder()
			lastDeAggroTime = now
			lastHitSleeper.Sleep(120)
			return true
		}

		return false
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || ExecuteOrder.DisableHumanizer) {
			return
		}

		if (!this.enabled.value) {
			return
		}

		const player = LocalPlayer
		if (!player) {
			return
		}
		const hero = player.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		const isLastHitKeyPressed = this.lastHitKey.isPressed
		const isSpellsKeyPressed = this.spellsKey.isPressed

		if (!isLastHitKeyPressed && !isSpellsKeyPressed) {
			return
		}

		// -------------------------------------------------------------
		// BACKSWING ANIMATION CANCELING (Orbwalk instantly after shot)
		// -------------------------------------------------------------
		if (
			this.cancelBackswing.value &&
			hero.IsInAnimation &&
			hero.LastAnimationIsAttack &&
			hero.LastAnimationCasted
		) {
			const mousePos = InputManager.CursorOnWorld
			if (mousePos && mousePos.IsValid && !lastHitSleeper.Sleeping) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
					issuers: [hero],
					position: mousePos,
					queue: false,
					showEffects: false,
					isPlayerInput: false
				})
				claimOrder()
				lastHitSleeper.Sleep(sleepTime(hero))
				return
			}
		}

		if (lastHitSleeper.Sleeping) {
			return
		}

		// Don't issue a new order if we're mid-attack-animation windup
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

		if (
			lastAttackOrderTime > 0 &&
			GameState.RawServerTime * 1000 - lastAttackOrderTime <
				hero.GetNextAttackPoint(GameState.InputLag) * 1000 + 20
		) {
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed || hero.IsInvisible) {
			return
		}

		// Auto De-Aggro Check
		if (this.autoDeAggro.value && this.handleDeAggro(hero)) {
			return
		}

		const heroAttackRange = hero.GetAttackRange(undefined, 0, false)
		const searchRadius = heroAttackRange + 350

		const creeps = EntityManager.GetEntitiesByClass(Creep).filter(
			c => c.IsValid && c.IsAlive && c.IsVisible && hero.Distance2D(c) <= searchRadius
		)

		// -------------------------------------------------------------
		// 1. LAST HIT & DENY WITH ATTACKS
		// -------------------------------------------------------------
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
					const safeDamage = attackDamage * 0.93

					// Enemy race detection
					const enemyHit = this.getFastestEnemyLastHit(hero, creep)
					const enemyWinsRace =
						enemyHit !== null &&
						enemyHit.landTime < landTime &&
						predictedHP > 0 &&
						predictedHP <= enemyHit.attackDamage * 0.85

					// Enemy creep — Last Hit
					if (creep.IsEnemy(hero)) {
						if (predictedHP > 0 && predictedHP <= safeDamage && !enemyWinsRace) {
							candidates.push({
								creep,
								margin: attackDamage - predictedHP + (creepDist > effectiveRange ? 400 : 0),
								isDeny: false,
								isPrepHit: false
							})
						} else if (enemyWinsRace && creepDist <= effectiveRange && enemyHit !== null) {
							const afterOurHit = creep.HP - attackDamage
							const enemyLandHP = afterOurHit - enemyHit.attackDamage
							if (afterOurHit > 0 && enemyLandHP > 0 && enemyLandHP <= safeDamage) {
								candidates.push({
									creep,
									margin: 1500 + (attackDamage - enemyLandHP),
									isDeny: false,
									isPrepHit: true
								})
							}
						} else if (predictedHP <= 0 && creep.HP > 0 && creep.HP <= safeDamage && !enemyWinsRace) {
							candidates.push({
								creep,
								margin: attackDamage - creep.HP + (creepDist > effectiveRange ? 400 : 0),
								isDeny: false,
								isPrepHit: false
							})
						} else if (
							this.towerHelper.value &&
							creepDist <= effectiveRange &&
							predictedHP > safeDamage &&
							predictedHP <= safeDamage * 1.25
						) {
							// Pre-hit setup (Smart Under-Tower Helper)
							const afterOurHit = creep.HP - attackDamage
							const incomingDamage = this.getCurrentIncomingDamage(hero, creep)
							const afterPreHitPlusWave = afterOurHit - incomingDamage

							if (incomingDamage > 0 && afterPreHitPlusWave > 0 && afterPreHitPlusWave <= safeDamage) {
								candidates.push({
									creep,
									margin: 1000 + (attackDamage - afterPreHitPlusWave) + (enemyWinsRace ? 500 : 0),
									isDeny: false,
									isPrepHit: true
								})
							} else if (
								afterOurHit > 0 &&
								afterOurHit <= safeDamage &&
								!this.hasCreepNearKillRange(hero, creeps, creep, heroAttackRange, effectiveRange)
							) {
								candidates.push({
									creep,
									margin: 2500 + (attackDamage - afterOurHit) * 0.5,
									isDeny: false,
									isPrepHit: true
								})
							}
						}
					}
					// Friendly creep — Deny
					else if (this.denyEnabled.value && creep.IsDeniable && creep.HP / creep.MaxHP < 0.5) {
						if (predictedHP > 0 && predictedHP <= safeDamage) {
							candidates.push({
								creep,
								margin: attackDamage - predictedHP + (creepDist > effectiveRange ? 400 : 0),
								isDeny: true,
								isPrepHit: false
							})
						} else if (predictedHP <= 0 && creep.HP > 0 && creep.HP <= safeDamage) {
							candidates.push({
								creep,
								margin: attackDamage - creep.HP + (creepDist > effectiveRange ? 400 : 0),
								isDeny: true,
								isPrepHit: false
							})
						}
					}
				}
			}

			if (candidates.length > 0) {
				const prioritizeDeny = this.prioritySetting.SelectedID === 1

				candidates.sort((a, b) => {
					if (a.isPrepHit !== b.isPrepHit) {
						return a.isPrepHit ? 1 : -1
					}
					if (a.isDeny !== b.isDeny && !a.isPrepHit) {
						return prioritizeDeny ? (a.isDeny ? -1 : 1) : a.isDeny ? 1 : -1
					}
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
				claimOrder()
				lastAttackTargetIdx = best.creep.Index
				lastAttackOrderTime = GameState.RawServerTime * 1000
				lastHitSleeper.Sleep(sleepTime(hero))
				return
			}
		}

		// -------------------------------------------------------------
		// 2. SPELL LAST HIT (When spellsKey is pressed or toggle is on)
		// -------------------------------------------------------------
		if ((isSpellsKeyPressed || this.spellsEnabled.value) && !hero.IsSilenced) {
			const usableSpells = hero.Spells.filter((s): s is Ability => {
				if (!s || !s.IsValid || s.IsHidden || s.IsItem || !s.CanBeCasted()) {
					return false
				}
				if (s.IsPassive) {
					return false
				}
				if (s.AbilitySlot !== undefined && (s.AbilitySlot === 3 || s.AbilitySlot > 3)) {
					return false
				}
				return true
			})

			let bestSpellCombo: { creep: Creep; spell: Ability; margin: number } | undefined

			for (const creep of creeps) {
				if (!creep.IsEnemy(hero)) {
					continue
				}
				for (const spell of usableSpells) {
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
					} else if (predictedSpellHP <= 0 && creep.HP > 0 && creep.HP <= safeSpellDamage) {
						const margin = spellDamage - creep.HP
						if (!bestSpellCombo || margin < bestSpellCombo.margin) {
							bestSpellCombo = { creep, spell, margin }
						}
					}
				}
			}

			if (bestSpellCombo) {
				const { creep, spell } = bestSpellCombo

				if (spell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: spell.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				} else if (spell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: creep.Position,
						ability: spell.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				} else if (spell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
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
				claimOrder()
				lastAttackTargetIdx = creep.Index
				lastAttackOrderTime = GameState.RawServerTime * 1000
				lastHitSleeper.Sleep(sleepTime(hero) + spell.CastPoint * 1000)
				return
			}
		}

		// -------------------------------------------------------------
		// 3. HARASS ENEMY HEROES
		// -------------------------------------------------------------
		if (isLastHitKeyPressed && this.harassEnabled.value && !hero.IsDisarmed && hero.CanAttack()) {
			const inEnemyTowerRange = EntityManager.GetEntitiesByClass(Tower).some(
				t =>
					t.IsValid &&
					t.IsAlive &&
					t.IsEnemy(hero) &&
					hero.Position.Distance2D(t.Position) <= t.GetAttackRange(hero)
			)

			const nearEnemyCreeps = EntityManager.GetEntitiesByClass(Creep).some(
				c => c.IsValid && c.IsAlive && c.IsEnemy(hero) && hero.Position.Distance2D(c.Position) <= 500
			)

			const safeToHarass = this.aggressiveHarass.value || (!inEnemyTowerRange && !nearEnemyCreeps)

			if (safeToHarass) {
				let bestHarassTarget: Hero | undefined
				let minDist = Infinity

				const heroes = EntityManager.GetEntitiesByClass(Hero)
				for (const enemy of heroes) {
					if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
						const dist = hero.Distance2D(enemy)
						if (dist <= this.harassSearchRadius.value && dist < minDist) {
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
					claimOrder()
					lastAttackTargetIdx = bestHarassTarget.Index
					lastAttackOrderTime = GameState.RawServerTime * 1000
					lastHitSleeper.Sleep(sleepTime(hero))
					return
				}
			}
		}

		// -------------------------------------------------------------
		// 4. FOLLOW CURSOR (Idle movement)
		// -------------------------------------------------------------
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
				claimOrder()
				lastHitSleeper.Sleep(sleepTime(hero))
			}
		}
	}
}

new CustomLastHit()
