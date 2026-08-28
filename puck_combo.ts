import {
	Color,
	DOTA_ABILITY_BEHAVIOR,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	Fountain,
	GameState,
	Hero,
	InputManager,
	LocalPlayer,
	Menu,
	ParticleAttachment,
	ParticlesSDK,
	RendererSDK,
	TickSleeper,
	Vector2,
	Vector3,
	VMouseKeys
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"
import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = [
	"item_blink",
	"item_sheepstick",
	"item_orchid",
	"item_bloodthorn",
	"item_nullifier",
	"item_rod_of_atos",
	"item_ethereal_blade",
	"item_veil_of_discord",
	"item_shivas_guard",
	"puck_dream_coil",
	"puck_waning_rift",
	"puck_illusory_orb",
	"item_dagon",
	"puck_phase_shift"
]

new (class PuckCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Puck Combo", "panorama/images/heroes/icons/npc_dota_hero_puck_png.vtex_c", "", 0)

	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Puck combo script")
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Puck combo")

	// Wave Clear & Escape Settings (Key 1)
	private readonly clearCreepNode = this.entry.AddNode("Wave Clear & Escape (Key 1)")
	private readonly clearCreepKey = this.clearCreepNode.AddKeybind(
		"Clear Creep & Escape Key",
		"1",
		"Hold to clear creep wave with Waning Rift and escape with Illusory Orb + Auto-Jaunt"
	)
	private readonly maxOrbDistance = this.clearCreepNode.AddSlider(
		"Max Orb Travel Distance",
		1950,
		1000,
		1950,
		50,
		"Maximum distance the escape Illusory Orb will travel towards safe fountain direction"
	)
	private readonly autoJauntOnMax = this.clearCreepNode.AddToggle(
		"Auto-Jaunt on Max Distance",
		true,
		"Automatically cast Ethereal Jaunt to the escape orb when holding the key"
	)

	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"If enabled, locks onto a single target hero when pressing the combo key"
	)
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 900, 300, 1600)

	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		[
			"item_blink",
			"item_sheepstick",
			"item_orchid",
			"item_bloodthorn",
			"item_nullifier",
			"item_rod_of_atos",
			"item_ethereal_blade",
			"item_veil_of_discord",
			"item_shivas_guard",
			"item_dagon",
			"item_black_king_bar",
			"item_cyclone"
		],
		new Map([
			["item_blink", true],
			["item_sheepstick", true],
			["item_orchid", true],
			["item_bloodthorn", true],
			["item_nullifier", true],
			["item_rod_of_atos", true],
			["item_ethereal_blade", true],
			["item_veil_of_discord", true],
			["item_shivas_guard", true],
			["item_dagon", true],
			["item_black_king_bar", true],
			["item_cyclone", false]
		]),
		"Toggle item usage in the combo"
	)

	// Dream Coil multi-target latch
	private readonly multiCoil = this.entry.AddToggle(
		"Multi-Hero Dream Coil",
		true,
		"Optimize Dream Coil placement to latch onto multiple clumped enemies"
	)

	private readonly smartOrbWalkEnabled = this.entry.AddToggle("Enable Smart Orb Walk", true)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider("Orb Walk Safe Distance %", 80, 10, 100, 5)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle("Stop-to-Cancel Backswing", false)

	// Visuals
	private readonly showStatusHUD = this.entry.AddToggle("Draw Status HUD", true)
	private statusHudPos = new Vector2(50, 400)
	private isDraggingStatus = false

	private comboSequenceGrid: any
	private lockedTarget: Hero | undefined = undefined
	private escapeOrbCastTime = 0

	private readonly sleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		COMBO_SPELLS.forEach((name, i) => defaultCombo.set(name, [true, true, true, i]))

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector("Combo Order", COMBO_SPELLS, defaultCombo)

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("Draw", this.Draw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero(): boolean {
		return Boolean(LocalPlayer?.Hero?.IsValid && LocalPlayer.Hero.Name === "npc_dota_hero_puck")
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.lockedTarget = undefined
		this.escapeOrbCastTime = 0
		this.pSDK.DestroyAll()
	}

	private findOptimalCoilPosition(hero: Hero, primaryTarget: Hero): Vector3 {
		if (!this.multiCoil.value) {
			return primaryTarget.Position.Clone()
		}

		const coilRadius = 375
		const enemies = EntityManager.GetEntitiesByClass(Hero).filter(
			e =>
				e.IsValid &&
				e.IsAlive &&
				e.IsVisible &&
				e.IsEnemy(hero) &&
				!e.IsIllusion &&
				e.Distance2D(primaryTarget) <= coilRadius * 1.8
		)

		if (enemies.length <= 1) {
			return primaryTarget.Position.Clone()
		}

		let avgX = 0
		let avgY = 0
		let avgZ = 0
		for (const enemy of enemies) {
			avgX += enemy.Position.x
			avgY += enemy.Position.y
			avgZ += enemy.Position.z
		}

		return new Vector3(avgX / enemies.length, avgY / enemies.length, avgZ / enemies.length)
	}

	private executeOrderAndClaim(order: any, delay: number): void {
		ExecuteOrder.PrepareOrder(order)
		claimOrder()
		this.sleeper.Sleep(delay)
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.pSDK.DestroyByKey("puck_locked_target")
			return
		}

		if (!this.comboEnabled.value) {
			this.pSDK.DestroyByKey("puck_locked_target")
			return
		}

		const isHeroCombo = this.comboKey.isPressed
		const isCreepCombo = this.clearCreepKey.isPressed

		if (!isHeroCombo && !isCreepCombo) {
			this.lockedTarget = undefined
			this.escapeOrbCastTime = 0
			this.pSDK.DestroyByKey("puck_locked_target")
			return
		}

		// Handle Clear Creep & Escape combo (including Phase Shift & Auto-Jaunt)
		if (isCreepCombo) {
			this.executeClearCreepCombo(hero)
			return
		}

		// Hero Combo: Don't act while phase-shifted, channeling, or disabled
		if (
			hero.IsChanneling ||
			hero.IsStunned ||
			hero.IsSilenced ||
			hero.IsHexed ||
			hero.HasBuffByName("modifier_puck_phase_shift")
		) {
			return
		}

		// -------------------------------------------------------------
		// TARGET LOCKING SYSTEM
		// -------------------------------------------------------------
		let bestTarget: Hero | undefined
		const lockTarget = this.lockTargetEnabled.value

		if (lockTarget) {
			if (this.lockedTarget) {
				if (
					!this.lockedTarget.IsValid ||
					!this.lockedTarget.IsAlive ||
					!this.lockedTarget.IsVisible ||
					this.lockedTarget.IsIllusion
				) {
					this.lockedTarget = undefined
				}
			}

			if (!this.lockedTarget) {
				const maxCastRange = 1300
				const mousePos = InputManager.CursorOnWorld
				let foundTarget: Hero | undefined
				let minDist = Infinity

				for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
					if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
						const distToCursor = enemy.Position.Distance2D(mousePos)
						const distToHero = hero.Distance2D(enemy)
						if (
							distToCursor < this.comboRadius.value &&
							distToHero <= maxCastRange &&
							distToCursor < minDist
						) {
							minDist = distToCursor
							foundTarget = enemy
						}
					}
				}
				if (foundTarget) {
					this.lockedTarget = foundTarget
				}
			}
			bestTarget = this.lockedTarget
		} else {
			const maxCastRange = 1300
			const mousePos = InputManager.CursorOnWorld
			let foundTarget: Hero | undefined
			let minDist = Infinity

			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
					const distToCursor = enemy.Position.Distance2D(mousePos)
					const distToHero = hero.Distance2D(enemy)
					if (distToCursor < this.comboRadius.value && distToHero <= maxCastRange && distToCursor < minDist) {
						minDist = distToCursor
						foundTarget = enemy
					}
				}
			}
			bestTarget = foundTarget
		}

		if (!bestTarget) {
			this.pSDK.DestroyByKey("puck_locked_target")
			return
		}

		// Target visual particle ring
		this.pSDK.DrawCircle("puck_locked_target", bestTarget, 130, {
			Color: new Color(255, 60, 220, 220),
			Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
		})

		if (this.sleeper.Sleeping) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune
		const targetDist = hero.Distance2D(bestTarget)
		const delay = GameState.InputLag * 1000 + 50

		// -------------------------------------------------------------
		// DYNAMIC COMBO SEQUENCE EXECUTION
		// -------------------------------------------------------------
		for (const entryName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(entryName)) {
				continue
			}

			// 1. Blink Dagger
			if (entryName === "item_blink") {
				if (this.itemsSelector.IsEnabled("item_blink") && !hero.IsMuted) {
					const blink = hero.Items.find(
						item =>
							item.Name === "item_blink" ||
							item.Name === "item_swift_blink" ||
							item.Name === "item_overwhelming_blink" ||
							item.Name === "item_arcane_blink"
					)
					if (blink && blink.CanBeUsable && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost) {
						if (targetDist > 400 && targetDist <= 1200) {
							this.executeOrderAndClaim(
								{
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
									issuers: [hero],
									position: bestTarget.Position,
									ability: blink.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								},
								delay + 50
							)
							return
						}
					}
				}
				continue
			}

			// 2. BKB (Black King Bar)
			if (entryName === "item_black_king_bar") {
				if (this.itemsSelector.IsEnabled("item_black_king_bar") && !hero.IsMuted) {
					const bkb = hero.GetItemByName("item_black_king_bar")
					if (bkb && bkb.CanBeUsable && bkb.Cooldown <= 0.1 && !hero.IsDebuffImmune) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
								issuers: [hero],
								ability: bkb.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// 3. Scythe of Vyse (Hex)
			if (entryName === "item_sheepstick") {
				if (this.itemsSelector.IsEnabled("item_sheepstick") && !hero.IsMuted && !isTargetImmune) {
					const hex = hero.GetItemByName("item_sheepstick")
					if (
						hex &&
						hex.CanBeUsable &&
						hex.Cooldown <= 0.1 &&
						hero.Mana >= hex.ManaCost &&
						targetDist <= (hex.CastRange || 800)
					) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: hex.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// 4. Orchid / Bloodthorn
			if (entryName === "item_orchid" || entryName === "item_bloodthorn") {
				if (
					(this.itemsSelector.IsEnabled("item_orchid") || this.itemsSelector.IsEnabled("item_bloodthorn")) &&
					!hero.IsMuted &&
					!isTargetImmune
				) {
					const silenceItem = hero.GetItemByName("item_bloodthorn") ?? hero.GetItemByName("item_orchid")
					if (
						silenceItem &&
						silenceItem.CanBeUsable &&
						silenceItem.Cooldown <= 0.1 &&
						hero.Mana >= silenceItem.ManaCost &&
						targetDist <= (silenceItem.CastRange || 800)
					) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: silenceItem.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// 5. Nullifier
			if (entryName === "item_nullifier") {
				if (this.itemsSelector.IsEnabled("item_nullifier") && !hero.IsMuted && !isTargetImmune) {
					const nullifier = hero.GetItemByName("item_nullifier")
					if (
						nullifier &&
						nullifier.CanBeUsable &&
						nullifier.Cooldown <= 0.1 &&
						hero.Mana >= nullifier.ManaCost &&
						targetDist <= (nullifier.CastRange || 800)
					) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: nullifier.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// 6. Rod of Atos / Gleipnir
			if (entryName === "item_rod_of_atos") {
				if (this.itemsSelector.IsEnabled("item_rod_of_atos") && !hero.IsMuted && !isTargetImmune) {
					const atos = hero.GetItemByName("item_rod_of_atos")
					const gleipnir = hero.GetItemByName("item_gungir")
					const rootItem = gleipnir ?? atos
					if (
						rootItem &&
						rootItem.CanBeUsable &&
						rootItem.Cooldown <= 0.1 &&
						hero.Mana >= rootItem.ManaCost
					) {
						if (rootItem.Name === "item_gungir") {
							this.executeOrderAndClaim(
								{
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
									issuers: [hero],
									position: bestTarget.Position,
									ability: rootItem.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								},
								delay
							)
							return
						} else if (targetDist <= (rootItem.CastRange || 1000)) {
							this.executeOrderAndClaim(
								{
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
									issuers: [hero],
									target: bestTarget.Index,
									ability: rootItem.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								},
								delay
							)
							return
						}
					}
				}
				continue
			}

			// 7. Ethereal Blade
			if (entryName === "item_ethereal_blade") {
				if (this.itemsSelector.IsEnabled("item_ethereal_blade") && !hero.IsMuted && !isTargetImmune) {
					const eblade = hero.GetItemByName("item_ethereal_blade")
					if (
						eblade &&
						eblade.CanBeUsable &&
						eblade.Cooldown <= 0.1 &&
						hero.Mana >= eblade.ManaCost &&
						targetDist <= (eblade.CastRange || 800)
					) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: eblade.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// 8. Veil of Discord
			if (entryName === "item_veil_of_discord") {
				if (this.itemsSelector.IsEnabled("item_veil_of_discord") && !hero.IsMuted && !isTargetImmune) {
					const veil = hero.GetItemByName("item_veil_of_discord")
					if (veil && veil.CanBeUsable && veil.Cooldown <= 0.1 && hero.Mana >= veil.ManaCost) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: bestTarget.Position,
								ability: veil.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// 9. Shiva's Guard
			if (entryName === "item_shivas_guard") {
				if (this.itemsSelector.IsEnabled("item_shivas_guard") && !hero.IsMuted) {
					const shiva = hero.GetItemByName("item_shivas_guard")
					if (
						shiva &&
						shiva.CanBeUsable &&
						shiva.Cooldown <= 0.1 &&
						hero.Mana >= shiva.ManaCost &&
						targetDist <= 900
					) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
								issuers: [hero],
								ability: shiva.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// 10. Dagon 1-5
			if (entryName === "item_dagon") {
				if (this.itemsSelector.IsEnabled("item_dagon") && !hero.IsMuted && !isTargetImmune) {
					const dagon = hero.Items.find(i => i.Name.startsWith("item_dagon"))
					if (
						dagon &&
						dagon.CanBeUsable &&
						dagon.Cooldown <= 0.1 &&
						hero.Mana >= dagon.ManaCost &&
						targetDist <= (dagon.CastRange || 750)
					) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: dagon.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay
						)
						return
					}
				}
				continue
			}

			// -------------------------------------------------------------
			// PUCK HERO SPELLS
			// -------------------------------------------------------------

			// Dream Coil (R)
			if (entryName === "puck_dream_coil") {
				const coil = hero.GetAbilityByName("puck_dream_coil")
				if (coil && coil.IsValid && coil.Level > 0 && coil.Cooldown <= 0.1 && hero.Mana >= coil.ManaCost) {
					const castRange = coil.CastRange > 0 ? coil.CastRange : 800
					if (targetDist <= castRange + 300) {
						const coilPos = this.findOptimalCoilPosition(hero, bestTarget)
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: coilPos,
								ability: coil.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay + coil.CastPoint * 1000
						)
						return
					}
				}
				continue
			}

			// Waning Rift (W Leap)
			if (entryName === "puck_waning_rift") {
				const rift = hero.GetAbilityByName("puck_waning_rift")
				if (rift && rift.IsValid && rift.Level > 0 && rift.Cooldown <= 0.1 && hero.Mana >= rift.ManaCost) {
					const maxLeapDist = 400
					const dir = bestTarget.Position.Subtract(hero.Position).Normalize()
					const leapDist = Math.min(targetDist, maxLeapDist)
					const leapPos = hero.Position.Add(dir.MultiplyScalar(leapDist))

					if (targetDist <= maxLeapDist + (rift.CastRange || 400)) {
						this.executeOrderAndClaim(
							{
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: leapPos,
								ability: rift.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							},
							delay + rift.CastPoint * 1000
						)
						return
					}
				}
				continue
			}

			// Illusory Orb (Q) - Burst Damage towards Enemy in Combo!
			if (entryName === "puck_illusory_orb") {
				const orb = hero.GetAbilityByName("puck_illusory_orb")
				if (orb && orb.IsValid && orb.Level > 0 && orb.Cooldown <= 0.1 && hero.Mana >= orb.ManaCost) {
					const castRange = orb.CastRange > 0 ? orb.CastRange : 1800
					if (targetDist <= castRange) {
						const isVector = orb.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_VECTOR_TARGETING)
						if (isVector) {
							hero.CastVectorTargetPosition(orb, bestTarget.Position, bestTarget.Position)
						} else {
							hero.CastPosition(orb, bestTarget.Position)
						}
						claimOrder()
						this.sleeper.Sleep(delay + orb.CastPoint * 1000)
						return
					}
				}
				continue
			}

			// Phase Shift (E)
			if (entryName === "puck_phase_shift") {
				const phase = hero.GetAbilityByName("puck_phase_shift")
				if (phase && phase.IsValid && phase.Level > 0 && phase.Cooldown <= 0.1 && hero.Mana >= phase.ManaCost) {
					this.executeOrderAndClaim(
						{
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
							issuers: [hero],
							ability: phase.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						},
						delay
					)
					return
				}
				continue
			}
		}

		// Orbwalk towards target
		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}

	/**
	 * Clear Creep Wave & Instant Escape Routine with Max Distance Orb & Auto Jaunt
	 */
	private executeClearCreepCombo(hero: Hero): void {
		const isPhaseShifted = hero.HasBuffByName("modifier_puck_phase_shift")
		const jaunt = hero.GetAbilityByName("puck_ethereal_jaunt")
		const isJauntReady = Boolean(
			jaunt && jaunt.IsValid && !jaunt.IsHidden && jaunt.Level > 0 && jaunt.Cooldown <= 0.1
		)

		// 5. AUTO JAUNT: If inside Phase Shift and holding key 1, auto jaunt when Orb reaches max distance or right before Phase Shift ends
		if (isPhaseShifted && isJauntReady && jaunt) {
			const phaseBuff = hero.GetBuffByName("modifier_puck_phase_shift")
			const remainingPhaseTime = phaseBuff ? phaseBuff.RemainingTime : 0
			const orbTravelTime = GameState.RawServerTime - this.escapeOrbCastTime
			const maxOrbTravelDuration = this.maxOrbDistance.value / 651 // e.g. 1950 / 651 ≈ 3.0s

			if (
				this.autoJauntOnMax.value &&
				(orbTravelTime >= maxOrbTravelDuration - 0.25 || remainingPhaseTime <= 0.2)
			) {
				this.executeOrderAndClaim(
					{
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: jaunt.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					},
					GameState.InputLag * 1000 + 100
				)
				this.escapeOrbCastTime = 0
				return
			}
			return
		}

		if (isPhaseShifted || hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		const mousePos = InputManager.CursorOnWorld
		const delay = GameState.InputLag * 1000 + 40

		// 1. Blink into creep wave
		if (this.itemsSelector.IsEnabled("item_blink") && !hero.IsMuted) {
			const blink = hero.Items.find(
				item =>
					item.Name === "item_blink" ||
					item.Name === "item_swift_blink" ||
					item.Name === "item_overwhelming_blink" ||
					item.Name === "item_arcane_blink"
			)
			if (blink && blink.CanBeUsable && blink.Cooldown <= 0.1 && hero.Distance2D(mousePos) > 350) {
				this.executeOrderAndClaim(
					{
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: mousePos,
						ability: blink.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					},
					delay
				)
				return
			}
		}

		// 2. Waning Rift on Creep wave
		const rift = hero.GetAbilityByName("puck_waning_rift")
		if (rift && rift.IsValid && rift.Level > 0 && rift.Cooldown <= 0.1 && hero.Mana >= rift.ManaCost) {
			hero.CastPosition(rift, mousePos)
			claimOrder()
			this.sleeper.Sleep(delay + rift.CastPoint * 1000)
			return
		}

		// 3. Illusory Orb back towards friendly fountain at MAX DISTANCE
		const orb = hero.GetAbilityByName("puck_illusory_orb")
		if (orb && orb.IsValid && orb.Level > 0 && orb.Cooldown <= 0.1 && hero.Mana >= orb.ManaCost) {
			const friendlyFountain = EntityManager.GetEntitiesByClass(Fountain).find(f => f.IsValid && !f.IsEnemy(hero))
			const fountainPos = friendlyFountain
				? friendlyFountain.Position.Clone()
				: hero.Team === 2
				? new Vector3(-7400, -7300, 512)
				: new Vector3(7400, 7300, 512)

			const dir = fountainPos.Subtract(hero.Position).Normalize()
			const castDist = this.maxOrbDistance.value
			const castPos = hero.Position.Add(dir.MultiplyScalar(castDist))

			const isVector = orb.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_VECTOR_TARGETING)
			if (isVector) {
				const curveEndPos = hero.Position.Add(dir.MultiplyScalar(castDist))
				hero.CastVectorTargetPosition(orb, castPos, curveEndPos)
			} else {
				hero.CastPosition(orb, castPos)
			}
			claimOrder()
			this.escapeOrbCastTime = GameState.RawServerTime
			this.sleeper.Sleep(delay + orb.CastPoint * 1000)
			return
		}

		// 4. Phase Shift immediately
		const phase = hero.GetAbilityByName("puck_phase_shift")
		if (phase && phase.IsValid && phase.Level > 0 && phase.Cooldown <= 0.1 && hero.Mana >= phase.ManaCost) {
			this.executeOrderAndClaim(
				{
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: phase.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				},
				delay
			)
		}
	}

	private Draw(): void {
		if (ExecuteOrder.DisableHumanizer || !this.hasLocalHero || !this.showStatusHUD.value) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		const cursor = InputManager.CursorOnScreen
		const padX = 10
		const padY = 8
		const textH = RendererSDK.DefaultTextSize

		const isHeroComboPressed = this.comboKey.isPressed
		const isCreepComboPressed = this.clearCreepKey.isPressed
		const statusText = isHeroComboPressed ? "COMBO ACTIVE" : isCreepComboPressed ? "CLEAR CREEP" : "READY"
		const statusColor = isHeroComboPressed ? Color.Green : isCreepComboPressed ? Color.Aqua : Color.White

		const lines: { text: string; color: Color }[] = [
			{ text: `[Puck Combo] Status: ${statusText}`, color: statusColor },
			{
				text: `  Target: ${this.lockedTarget ? this.lockedTarget.Name.replace("npc_dota_hero_", "") : "None"}`,
				color: this.lockedTarget ? Color.Yellow : Color.LightGray
			},
			{
				text: `  Dream Coil: ${hero.GetAbilityByName("puck_dream_coil")?.Cooldown.toFixed(1) ?? "0"}s`,
				color: (hero.GetAbilityByName("puck_dream_coil")?.Cooldown ?? 0) <= 0.1 ? Color.Green : Color.Red
			},
			{
				text: `  Max Orb Dist: ${this.maxOrbDistance.value} | Auto-Jaunt: ${
					this.autoJauntOnMax.value ? "ON" : "OFF"
				}`,
				color: Color.Aqua
			}
		]

		let maxW = 0
		for (const line of lines) {
			const sz = RendererSDK.GetTextSize(line.text, RendererSDK.DefaultFontName, RendererSDK.DefaultTextSize)
			if (sz.x > maxW) {
				maxW = sz.x
			}
		}

		const w = Math.max(maxW + padX * 2, 180)
		const h = lines.length * textH + padY * 2
		const pos = this.statusHudPos

		if (InputManager.IsMouseKeyDown(VMouseKeys.MK_LBUTTON)) {
			if (
				!this.isDraggingStatus &&
				cursor.x >= pos.x &&
				cursor.x <= pos.x + w &&
				cursor.y >= pos.y &&
				cursor.y <= pos.y + h
			) {
				this.isDraggingStatus = true
			}
		} else {
			this.isDraggingStatus = false
		}

		if (this.isDraggingStatus) {
			this.statusHudPos.CopyFrom(cursor.Subtract(new Vector2(w / 2, h / 2)))
		}

		RendererSDK.FilledRect(this.statusHudPos, new Vector2(w, h), new Color(0, 0, 0, 220))
		RendererSDK.OutlinedRect(
			this.statusHudPos,
			new Vector2(w, h),
			1.5,
			isHeroComboPressed ? new Color(255, 60, 220, 220) : new Color(0, 200, 255, 200)
		)

		let ly = this.statusHudPos.y + padY
		for (const line of lines) {
			RendererSDK.Text(line.text, new Vector2(this.statusHudPos.x + padX, ly), line.color)
			ly += textH
		}
	}
})()
