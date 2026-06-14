import {
	Ability,
	ATTACK_DAMAGE_STRENGTH,
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
	Unit,
	UnitData,
	WorldUtils
} from "github.com/octarine-public/wrapper/index"

const lastHitSleeper = new TickSleeper()

class CustomLastHit {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Custom Last Hit")

	private readonly lastHitKey = this.entry.AddKeybind("Hold Key", "Space", "Hold to auto last hit and deny")
	private readonly spellsKey = this.entry.AddKeybind("Spells Key", "None", "Hold to auto last hit using spells")
	private readonly denyEnabled = this.entry.AddToggle("Deny Friendly Creeps", true)
	private readonly prioritySetting = this.entry.AddDropdown(
		"Action Priority",
		["Last Hit", "Deny"],
		0,
		"Select which action to prioritize"
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
	private readonly aggressiveHarass = this.harassNode.AddToggle("Aggressive Harass (Ignore aggro/tower)", false)
	private readonly harassSearchRadius = this.harassNode.AddSlider("Harass Search Radius", 800, 300, 1500)

	// Track attack timing for more accurate predictions
	private readonly unitAttackRecords = new Map<number, { lastAttackTime: number; attackCount: number }>()
	private readonly unitTargets = new Map<number, number>()
	private readonly pSDK = new ParticlesSDK()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private onGameEnded(): void {
		this.unitTargets.clear()
		this.unitAttackRecords.clear()
		lastHitSleeper.Sleep(0)
		this.pSDK.DestroyAll()
	}

	private updateUnitTargets(): void {
		const currentTime = GameState.RawGameTime
		
		// Clean up invalid entities from the tracking map
		for (const [attackerIndex, targetIndex] of this.unitTargets.entries()) {
			const attacker = EntityManager.EntityByIndex<Unit>(attackerIndex)
			const target = EntityManager.EntityByIndex<Unit>(targetIndex)
			if (!attacker || !attacker.IsValid || !attacker.IsAlive || !target || !target.IsValid || !target.IsAlive) {
				this.unitTargets.delete(attackerIndex)
			}
		}

		// Update target tracking from active tracking projectiles
		const projectiles = ProjectileManager.AllTrackingProjectiles
		for (const proj of projectiles) {
			if (proj.IsValid && !proj.IsDodged && proj.Source && proj.Target && proj.Target instanceof Creep) {
				this.unitTargets.set(proj.Source.Index, proj.Target.Index)
				
				// Track attack timing for better prediction
				const record = this.unitAttackRecords.get(proj.Source.Index) || { lastAttackTime: 0, attackCount: 0 }
				if (record.lastAttackTime > 0) {
					const timeSinceLastAttack = currentTime - record.lastAttackTime
					// If attack interval matches expected attack speed, record it
					if (timeSinceLastAttack > 0.1) {
						record.attackCount++
					}
				}
				record.lastAttackTime = currentTime
				this.unitAttackRecords.set(proj.Source.Index, record)
			}
		}

		// Update target tracking from current unit/tower targets
		const allUnits = EntityManager.GetEntitiesByClass(Unit)
		for (const unit of allUnits) {
			if (!unit.IsValid || !unit.IsAlive || !unit.IsVisible) {
				continue
			}
			const target = unit.Target
			if (target && target instanceof Creep) {
				this.unitTargets.set(unit.Index, target.Index)
			}
		}
	}

	private predictCreepHealth(hero: Hero, creep: Creep, landTime: number): number {
		const currentTime = GameState.RawServerTime
		const timeDelta = Math.max(0, landTime - currentTime)
		let predictedHP = creep.HP

		// Account for HP regeneration over time
		// Creeps regen ~0.5-2 HP/sec normally, more with aura effects
		if (timeDelta > 0) {
			const hpRegen = creep.HPRegen || 0
			predictedHP += hpRegen * timeDelta
		}

		// Helper to calculate actual damage after armor/block
		const calculateActualDamage = (source: Unit, target: Creep, rawDamage: number): number => {
			if (!source || !target || !target.IsValid) return rawDamage

			// Get target armor (creeps have base armor from UnitData)
			const targetArmor = target.ArmorPhysical || 0

			// Standard Dota armor formula (handles both positive and negative armor)
			let armorMultiplier: number
			if (targetArmor >= 0) {
				armorMultiplier = 1 / (1 + 0.06 * targetArmor)
			} else {
				// For negative armor: damage_multiplier = 2 - 0.94^(-armor)
				armorMultiplier = 2 - Math.pow(0.94, -targetArmor)
			}

			// Damage block from Stout Shield / Vanguard / etc (approximate for creeps)
			// Lane creeps have small innate block, siege creeps have more
			let damageBlock = 0
			const unitData = target.UnitData
			if (unitData) {
				// Check if it's a ranged/siege creep which typically have more armor/block
				const name = unitData.Name?.toLowerCase() || ""
				if (name.includes("siege") || name.includes("ranged")) {
					damageBlock = 2 // siege/ranged creeps have slight block
				} else {
					damageBlock = 1 // melee creeps have minimal block
				}
			}

			// Apply armor multiplier
			let actualDamage = rawDamage * armorMultiplier

			// Apply damage block (only for physical attacks)
			actualDamage = Math.max(1, actualDamage - damageBlock)

			return actualDamage
		}

		// 1. Account for in-flight projectiles
		const projectiles = ProjectileManager.AllTrackingProjectiles
		for (const proj of projectiles) {
			if (!proj.IsValid || proj.IsDodged || !proj.Target || proj.Target.Index !== creep.Index) {
				continue
			}
			const source = proj.Source
			if (!source || source.Index === hero.Index) {
				continue
			}
			const dist = creep.Distance2D(proj.Position)
			const speed = proj.Speed > 0 ? proj.Speed : 1000
			const timeToImpact = dist / speed
			const projLandTime = currentTime + timeToImpact

			if (projLandTime <= landTime) {
				if (source instanceof Unit && source.IsValid) {
					const rawDamage = source.GetAttackDamage(creep, ATTACK_DAMAGE_STRENGTH.DAMAGE_AVG)
					const actualDamage = calculateActualDamage(source, creep, rawDamage)
					predictedHP -= actualDamage
				}
			}
		}

		// 2. Account for future attacks from units & towers targeting the creep
		const allUnits = EntityManager.GetEntitiesByClass(Unit)
		for (const unit of allUnits) {
			// Skip invalid, dead, invisible units and our hero
			if (!unit.IsValid || !unit.IsAlive || !unit.IsVisible || unit.Index === hero.Index || unit.IsDisarmed) {
				continue
			}
			if (!unit.IsEnemy(creep)) {
				continue
			}

			// Only track attacks from units targeting this creep
			const targetIndex = this.unitTargets.get(unit.Index)
			const isCurrentlyTargeting =
				(unit.Target && unit.Target.Index === creep.Index) || targetIndex === creep.Index
			if (!isCurrentlyTargeting) {
				continue
			}

			// Ensure unit is within attack range (towers have much larger range)
			const maxRange = unit.IsTower
				? unit.GetAttackRange(creep) + 100
				: unit.GetAttackRange(creep) + 150
			if (unit.Distance2D(creep) > maxRange) {
				continue
			}

			// Project when the next attack will fire
			let nextFireTime = 0
			const isInAnimation = unit.IsInAnimation && unit.LastAnimationIsAttack && !unit.LastAnimationCasted

			if (isInAnimation) {
				const remainingTime = unit.LastAnimationStartTime + unit.LastAnimationCastPoint - GameState.RawGameTime
				nextFireTime = currentTime + Math.max(0, remainingTime)
			} else {
				nextFireTime = Math.max(
					unit.AttackTimeAtLastTick + unit.SecondsPerAttack,
					currentTime + unit.GetNextAttackPoint(0)
				)
			}

			// Project when the attack will land
			const travelTime = unit.IsRanged
				? unit.Distance2D(creep) / (unit.AttackProjectileSpeed > 0 ? unit.AttackProjectileSpeed : 1000)
				: 0

			let currentUnitLandTime = nextFireTime + travelTime
			// Towers attack faster than creeps (usually 1.0 BAT for towers vs 1.5-1.7 for creeps)
			const secondsPerAttack = Math.max(unit.IsTower ? 0.8 : 0.1, unit.SecondsPerAttack > 0 ? unit.SecondsPerAttack : 1.5)

			while (currentUnitLandTime <= landTime) {
				const rawDamage = unit.GetAttackDamage(creep, ATTACK_DAMAGE_STRENGTH.DAMAGE_AVG)
				const actualDamage = calculateActualDamage(unit, creep, rawDamage)
				predictedHP -= actualDamage
				currentUnitLandTime += secondsPerAttack
			}
		}

		return Math.max(0, predictedHP)
	}

	private updateAttackRangeDraw(hero: Hero): void {
		const isKeyPressed = this.lastHitKey.isPressed || this.spellsKey.isPressed
		if (this.showAttackRange.value && isKeyPressed && hero && hero.IsValid && hero.IsAlive) {
			const attackRange = hero.GetAttackRange(undefined, 0, false)
			this.pSDK.DrawCircle("hero_attack_range", hero, attackRange, {
				Color: Color.Green,
				Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
			})
		} else {
			this.pSDK.DestroyByKey("hero_attack_range")
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || ExecuteOrder.DisableHumanizer) {
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

		// Update targeting map for all units
		this.updateUnitTargets()

		// Draw/update attack range display
		this.updateAttackRangeDraw(hero)

		const isLastHitKeyPressed = this.lastHitKey.isPressed
		const isSpellsKeyPressed = this.spellsKey.isPressed

		if (!isLastHitKeyPressed && !isSpellsKeyPressed) {
			return
		}

		if (lastHitSleeper.Sleeping) {
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed || hero.IsInvisible) {
			return
		}

		const creeps = EntityManager.GetEntitiesByClass(Creep).filter(c => {
			return c.IsValid && c.IsAlive && c.IsVisible && hero.Distance2D(c) <= hero.GetAttackRange(c) + 300
		})

		const usableSpells = hero.Spells.filter((s): s is Ability => {
			if (!s || !s.IsValid || s.IsHidden || s.IsItem || s.Level === 0) {
				return false
			}
			if (s.IsPassive) {
				return false
			}
			if (s.AbilitySlot !== undefined && s.AbilitySlot > 2) {
				return false
			}
			return s.Cooldown <= 0.1 && hero.Mana >= s.ManaCost
		})

		let bestLastHitCreep: Creep | undefined
		let bestDenyCreep: Creep | undefined
		let bestSpellLastHitCreep: Creep | undefined
		let bestSpell: Ability | undefined

		for (const creep of creeps) {
			const turnTime = hero.TurnTimeNew(creep.Position, false)
			const attackPoint = hero.GetNextAttackPoint(GameState.InputLag)

			// Calculate when our attack will land
			const landTime = GameState.RawServerTime + GameState.InputLag + turnTime + attackPoint

			// Predict creep HP at land time using our helper (which accounts for armor/block from other units)
			const predictedHP = this.predictCreepHealth(hero, creep, landTime)

			// Calculate our actual attack damage after armor reduction and damage block
			const rawAttackDamage = hero.GetAttackDamage(creep, ATTACK_DAMAGE_STRENGTH.DAMAGE_AVG)

			// Apply armor reduction and damage block for OUR attack on this creep
			const targetArmor = creep.ArmorPhysical || 0
			const armorReduction = targetArmor * 0.06 / (1 + targetArmor * 0.06)
			let damageBlock = 0
			const unitData = creep.UnitData
			if (unitData) {
				const name = unitData.Name?.toLowerCase() || ""
				if (name.includes("siege") || name.includes("ranged")) {
					damageBlock = 2
				} else {
					damageBlock = 1
				}
			}
			const attackDamage = Math.max(1, rawAttackDamage * (1 - armorReduction) - damageBlock)

			if (creep.IsEnemy(hero)) {
				if (predictedHP <= attackDamage && predictedHP > 0) {
					if (!bestLastHitCreep || creep.HP < bestLastHitCreep.HP) {
						bestLastHitCreep = creep
					}
				} else if (this.spellsEnabled.value || isSpellsKeyPressed) {
					for (const spell of usableSpells) {
						const spellLandTime =
							GameState.RawServerTime +
							GameState.InputLag +
							hero.TurnTimeNew(creep.Position, false) +
							spell.CastPoint
						const predictedSpellHP = this.predictCreepHealth(hero, creep, spellLandTime)
						const spellDamage = spell.GetDamage(creep)
						if (predictedSpellHP <= spellDamage && predictedSpellHP > 0) {
							if (!bestSpellLastHitCreep || creep.HP < bestSpellLastHitCreep.HP) {
								bestSpellLastHitCreep = creep
								bestSpell = spell
							}
						}
					}
				}
			} else if (this.denyEnabled.value && creep.HP / creep.MaxHP < 0.5) {
				if (predictedHP <= attackDamage && predictedHP > 0) {
					if (!bestDenyCreep || creep.HP < bestDenyCreep.HP) {
						bestDenyCreep = creep
					}
				}
			}
		}

		const canAttack = !hero.IsDisarmed && hero.CanAttack()
		if (this.prioritySetting.SelectedID === 0) {
			if (bestLastHitCreep && canAttack) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
					issuers: [hero],
					target: bestLastHitCreep.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}
			if (bestDenyCreep && canAttack) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
					issuers: [hero],
					target: bestDenyCreep.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}
		} else {
			if (bestDenyCreep && canAttack) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
					issuers: [hero],
					target: bestDenyCreep.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}
			if (bestLastHitCreep && canAttack) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
					issuers: [hero],
					target: bestLastHitCreep.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}
		}

		if (bestSpellLastHitCreep && bestSpell) {
			const isTarget = bestSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)
			const isPosition = bestSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)
			const isNoTarget = bestSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)

			if (isNoTarget) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: bestSpell.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + bestSpell.CastPoint * 1000 + 100)
				return
			} else if (isPosition) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: bestSpellLastHitCreep.Position,
					ability: bestSpell.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + bestSpell.CastPoint * 1000 + 100)
				return
			} else if (isTarget) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestSpellLastHitCreep.Index,
					ability: bestSpell.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + bestSpell.CastPoint * 1000 + 100)
				return
			}
		}

		if (this.harassEnabled.value && !hero.IsDisarmed && hero.CanAttack()) {
			const inEnemyTowerRange = EntityManager.GetEntitiesByClass(Tower).some(t => {
				return (
					t.IsValid &&
					t.IsAlive &&
					t.IsEnemy(hero) &&
					hero.Position.Distance2D(t.Position) <= t.GetAttackRange(hero)
				)
			})

			const nearEnemyCreeps = EntityManager.GetEntitiesByClass(Creep).some(c => {
				return c.IsValid && c.IsAlive && c.IsEnemy(hero) && hero.Position.Distance2D(c.Position) <= 500
			})

			const safeToHarass = this.aggressiveHarass.value || (!inEnemyTowerRange && !nearEnemyCreeps)

			if (safeToHarass) {
				let bestHarassTarget: Hero | undefined
				let minDist = Infinity
				const searchRadius = this.harassSearchRadius.value

				const heroes = EntityManager.GetEntitiesByClass(Hero)
				for (const enemy of heroes) {
					if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
						const dist = hero.Distance2D(enemy)
						if (dist <= searchRadius && dist < minDist) {
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
					lastHitSleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
			}
		}

		if (this.followCursor.value) {
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
				lastHitSleeper.Sleep(GameState.InputLag * 1000 + 100)
			}
		}
	}
}

new CustomLastHit()
