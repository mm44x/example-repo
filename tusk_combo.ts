import {
	Ability,
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
	Item,
	LocalPlayer,
	Menu,
	ParticleAttachment,
	ParticlesSDK,
	TickSleeper,
	Unit,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"
import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = [
	"tusk_walrus_kick",
	"tusk_snowball",
	"tusk_ice_shards",
	"tusk_tag_team",
	"tusk_walrus_punch",
	"tusk_drinking_buddies"
]

const COMBO_ITEMS = [
	"item_blink",
	"item_urn_of_shadows",
	"item_spirit_vessel",
	"item_medallion_of_courage",
	"item_solar_crest",
	"item_heavens_halberd",
	"item_orchid",
	"item_bloodthorn",
	"item_sheepstick",
	"item_nullifier",
	"item_shivas_guard",
	"item_phase_boots",
	"item_black_king_bar",
	"item_blade_mail",
	"item_dagon",
	"item_ethereal_blade"
]

new (class TuskCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Tusk Combo", "panorama/images/heroes/icons/npc_dota_hero_tusk_png.vtex_c", "", 0)

	// Enable/Disable combo
	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Tusk combo script")

	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Tusk combo")
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"If enabled, locks onto a single target hero when pressing the combo key. If disabled, targets the enemy closest to your cursor on each tick."
	)
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)
	private readonly allySearchRadius = this.entry.AddSlider(
		"Ally Search Distance (Kick)",
		1500,
		500,
		3000,
		0,
		"Radius to search for teammates to kick the enemy towards"
	)

	// Snowball features
	private readonly autoPullAllies = this.entry.AddToggle(
		"Auto Pull Allies to Snowball",
		true,
		"Automatically pull nearby allies into the snowball while gathering or rolling"
	)
	private readonly snowballLaunchDelay = this.entry.AddSlider(
		"Snowball Launch Delay (s)",
		0.4,
		0.0,
		2.0,
		1,
		"Time to gather nearby allies before automatically launching snowball"
	)

	// Items selection
	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		COMBO_ITEMS,
		new Map(COMBO_ITEMS.map(name => [name, true])),
		"Toggle item usage in the combo"
	)

	// Orb walk settings
	private readonly smartOrbWalkEnabled = this.entry.AddToggle(
		"Enable Smart Orb Walk",
		true,
		"Follow moving targets by cancelling attack backswing"
	)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider(
		"Orb Walk Safe Distance %",
		80,
		10,
		100,
		0,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle(
		"Stop-to-Cancel Backswing",
		false,
		"Use STOP before moving during backswing cancel for crisper animation break"
	)

	private comboSequenceGrid: any
	private lockedTarget: Hero | undefined = undefined
	private snowballStartTime = 0

	// Sleepers
	private readonly sleeper = new TickSleeper()
	private readonly pullSleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("tusk_walrus_kick", [true, true, true, 0])
		defaultCombo.set("tusk_snowball", [true, true, true, 1])
		defaultCombo.set("tusk_ice_shards", [true, true, true, 2])
		defaultCombo.set("tusk_tag_team", [true, true, true, 3])
		defaultCombo.set("tusk_walrus_punch", [true, true, true, 4])
		defaultCombo.set("tusk_drinking_buddies", [true, true, true, 5])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector("Combo Order", COMBO_SPELLS, defaultCombo)

		for (const spell of COMBO_SPELLS) {
			if (!this.comboSequenceGrid.enabledValues.has(spell)) {
				this.comboSequenceGrid.enabledValues.set(spell, [
					true,
					true,
					true,
					this.comboSequenceGrid.enabledValues.size
				])
			}
			if (!this.comboSequenceGrid.values.includes(spell)) {
				this.comboSequenceGrid.values.push(spell)
			}
		}
		this.comboSequenceGrid.Update()

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("Draw", this.OnDraw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero() {
		return (
			LocalPlayer &&
			LocalPlayer.Hero &&
			LocalPlayer.Hero.IsValid &&
			LocalPlayer.Hero.Name === "npc_dota_hero_tusk"
		)
	}

	private OnDraw(): void {
		if (this.comboSequenceGrid) {
			let needsUpdate = false
			for (const spell of COMBO_SPELLS) {
				if (!this.comboSequenceGrid.values.includes(spell)) {
					this.comboSequenceGrid.values.push(spell)
					needsUpdate = true
				}
				if (!this.comboSequenceGrid.enabledValues.has(spell)) {
					this.comboSequenceGrid.enabledValues.set(spell, [
						true,
						true,
						true,
						this.comboSequenceGrid.enabledValues.size
					])
					needsUpdate = true
				}
			}
			if (needsUpdate) {
				this.comboSequenceGrid.Update()
			}
		}
	}

	private getItem(hero: Hero, name: string): Item | undefined {
		for (const item of hero.Items) {
			if (item && item.IsValid && item.Name === name) {
				return item
			}
		}
		return undefined
	}

	private executeItems(hero: Hero, bestTarget: Hero, isTargetImmune: boolean): boolean {
		const dist = hero.Distance2D(bestTarget)

		// 1. BLACK KING BAR (BKB)
		if (this.itemsSelector.IsEnabled("item_black_king_bar")) {
			const bkb = this.getItem(hero, "item_black_king_bar")
			if (bkb && bkb.Cooldown <= 0.1 && dist <= 650) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: bkb.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return true
			}
		}

		// 2. BLADE MAIL
		if (this.itemsSelector.IsEnabled("item_blade_mail")) {
			const bm = this.getItem(hero, "item_blade_mail")
			if (bm && bm.Cooldown <= 0.1 && dist <= 650) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: bm.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return true
			}
		}

		// 3. PHASE BOOTS
		if (this.itemsSelector.IsEnabled("item_phase_boots")) {
			const phase = this.getItem(hero, "item_phase_boots")
			if (phase && phase.Cooldown <= 0.1 && dist <= 900) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: phase.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// Items requiring target to NOT be Debuff Immune
		if (!isTargetImmune) {
			// 4. SCYTHE OF VYSE (HEX)
			if (this.itemsSelector.IsEnabled("item_sheepstick")) {
				const hex = this.getItem(hero, "item_sheepstick")
				if (
					hex &&
					hex.Cooldown <= 0.1 &&
					dist <= (hex.CastRange > 0 ? hex.CastRange : 800) &&
					!bestTarget.IsHexed &&
					!bestTarget.IsStunned
				) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: hex.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 5. ORCHID / BLOODTHORN
			if (this.itemsSelector.IsEnabled("item_bloodthorn") || this.itemsSelector.IsEnabled("item_orchid")) {
				const sil = this.getItem(hero, "item_bloodthorn") || this.getItem(hero, "item_orchid")
				if (
					sil &&
					sil.Cooldown <= 0.1 &&
					dist <= (sil.CastRange > 0 ? sil.CastRange : 900) &&
					!bestTarget.IsSilenced &&
					!bestTarget.IsHexed
				) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: sil.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 6. NULLIFIER
			if (this.itemsSelector.IsEnabled("item_nullifier")) {
				const nulli = this.getItem(hero, "item_nullifier")
				if (nulli && nulli.Cooldown <= 0.1 && dist <= (nulli.CastRange > 0 ? nulli.CastRange : 800)) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: nulli.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 7. HEAVEN'S HALBERD
			if (this.itemsSelector.IsEnabled("item_heavens_halberd")) {
				const halberd = this.getItem(hero, "item_heavens_halberd")
				if (
					halberd &&
					halberd.Cooldown <= 0.1 &&
					dist <= (halberd.CastRange > 0 ? halberd.CastRange : 650) &&
					!bestTarget.IsDisarmed
				) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: halberd.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 8. SOLAR CREST / MEDALLION
			if (
				this.itemsSelector.IsEnabled("item_solar_crest") ||
				this.itemsSelector.IsEnabled("item_medallion_of_courage")
			) {
				const solar = this.getItem(hero, "item_solar_crest") || this.getItem(hero, "item_medallion_of_courage")
				if (solar && solar.Cooldown <= 0.1 && dist <= (solar.CastRange > 0 ? solar.CastRange : 900)) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: solar.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 9. URN OF SHADOWS / SPIRIT VESSEL
			if (
				this.itemsSelector.IsEnabled("item_spirit_vessel") ||
				this.itemsSelector.IsEnabled("item_urn_of_shadows")
			) {
				const urn = this.getItem(hero, "item_spirit_vessel") || this.getItem(hero, "item_urn_of_shadows")
				if (
					urn &&
					urn.Cooldown <= 0.1 &&
					dist <= (urn.CastRange > 0 ? urn.CastRange : 950) &&
					urn.CurrentCharges > 0 &&
					!bestTarget.HasBuffByName("modifier_item_spirit_vessel_damage") &&
					!bestTarget.HasBuffByName("modifier_item_urn_damage")
				) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: urn.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 10. ETHEREAL BLADE
			if (this.itemsSelector.IsEnabled("item_ethereal_blade")) {
				const eb = this.getItem(hero, "item_ethereal_blade")
				if (eb && eb.Cooldown <= 0.1 && dist <= (eb.CastRange > 0 ? eb.CastRange : 800)) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: eb.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 11. DAGON
			if (this.itemsSelector.IsEnabled("item_dagon")) {
				const dagon =
					this.getItem(hero, "item_dagon") ||
					this.getItem(hero, "item_dagon_2") ||
					this.getItem(hero, "item_dagon_3") ||
					this.getItem(hero, "item_dagon_4") ||
					this.getItem(hero, "item_dagon_5")
				if (dagon && dagon.Cooldown <= 0.1 && dist <= (dagon.CastRange > 0 ? dagon.CastRange : 700)) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: dagon.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}
		}

		// 12. SHIVA'S GUARD
		if (this.itemsSelector.IsEnabled("item_shivas_guard")) {
			const shiva = this.getItem(hero, "item_shivas_guard")
			if (shiva && shiva.Cooldown <= 0.1 && dist <= 900) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: shiva.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return true
			}
		}

		return false
	}

	/**
	 * Execute ability on target, handling different behaviors.
	 */
	private executeComboAbility(
		hero: Hero,
		ability: Ability,
		target: Hero | Unit,
		isPosition = false,
		pos?: Vector3
	): boolean {
		const isNoTarget = ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)
		const isTarget = ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)
		const isPoint = ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)

		claimOrder()

		if (isPosition || isPoint) {
			const castPos = pos ?? target.Position.Clone()
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
				issuers: [hero],
				position: castPos,
				ability: ability.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		} else if (isTarget) {
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
				issuers: [hero],
				target: target.Index,
				ability: ability.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		} else if (isNoTarget) {
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
				issuers: [hero],
				ability: ability.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		}
		return false
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.pullSleeper.Sleep(0)
		this.lockedTarget = undefined
		this.snowballStartTime = 0
		this.pSDK.DestroyAll()

		if (this.comboSequenceGrid) {
			this.comboSequenceGrid.ResetToDefault()
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (!this.comboEnabled.value) {
			return
		}

		// Check if we are inside the Snowball
		const isInsideSnowball =
			hero.HasBuffByName("modifier_tusk_snowball_movement") ||
			hero.HasBuffByName("modifier_tusk_snowball_visible")

		if (isInsideSnowball) {
			if (this.snowballStartTime === 0) {
				this.snowballStartTime = GameState.RawGameTime
			}

			// Auto pull allies logic while in snowball
			if (this.autoPullAllies.value && !this.pullSleeper.Sleeping) {
				const grabRadius = 350
				for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
					if (
						ally.IsValid &&
						ally.IsAlive &&
						ally !== hero &&
						!ally.IsEnemy(hero) &&
						!ally.IsIllusion &&
						hero.Distance2D(ally) <= grabRadius &&
						!ally.HasBuffByName("modifier_tusk_snowball_movement_friendly")
					) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_TARGET,
							issuers: [hero],
							target: ally.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.pullSleeper.Sleep(120)
						break
					}
				}
			}

			// Launch snowball after configured delay
			const elapsed = GameState.RawGameTime - this.snowballStartTime
			if (elapsed >= this.snowballLaunchDelay.value) {
				const launch = hero.GetAbilityByName("tusk_launch_snowball")
				if (launch && launch.IsValid && !launch.IsHidden && launch.Level > 0 && launch.Cooldown <= 0.1) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: launch.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				}
			}
			return
		}
		this.snowballStartTime = 0

		// Check combo hotkey
		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("tusk_target_ring")
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// Target Selection & Verification
		let bestTarget: Hero | undefined = this.lockedTarget
		const lockTarget = this.lockTargetEnabled.value

		if (
			!bestTarget ||
			!bestTarget.IsValid ||
			!bestTarget.IsAlive ||
			!bestTarget.IsVisible ||
			bestTarget.IsIllusion
		) {
			const maxCastRange = 1200
			const mousePos = InputManager.CursorOnWorld
			let minDist = Infinity
			let foundTarget: Hero | undefined

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

			if (lockTarget && foundTarget) {
				this.lockedTarget = foundTarget
			}
			bestTarget = foundTarget
		}

		if (!bestTarget) {
			this.pSDK.DestroyByKey("tusk_target_ring")
			return
		}

		this.pSDK.DrawCircle("tusk_target_ring", bestTarget, 140, {
			Color: new Color(80, 180, 255, 220),
			Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
		})

		if (this.sleeper.Sleeping) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// Execute Items first
		if (this.executeItems(hero, bestTarget, isTargetImmune)) {
			return
		}

		// Execute Combo Sequence
		for (const spellName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			const ability = hero.GetAbilityByName(spellName)
			if (
				!ability ||
				!ability.IsValid ||
				ability.IsHidden ||
				ability.Level <= 0 ||
				ability.Cooldown > 0.1 ||
				hero.Mana < ability.ManaCost
			) {
				continue
			}

			// Magic immunity check for non-piercing spells
			if (isTargetImmune && spellName !== "tusk_walrus_punch" && spellName !== "tusk_walrus_kick") {
				continue
			}

			// Range check helper
			const castRange =
				ability.CastRange > 0
					? ability.CastRange
					: spellName === "tusk_walrus_kick" || spellName === "tusk_walrus_punch"
					? 250
					: 800

			const isBlinkKickReady =
				spellName === "tusk_walrus_kick" &&
				this.itemsSelector.IsEnabled("item_blink") &&
				(() => {
					const blink =
						this.getItem(hero, "item_blink") ||
						this.getItem(hero, "item_swift_blink") ||
						this.getItem(hero, "item_overwhelming_blink") ||
						this.getItem(hero, "item_arcane_blink")
					return blink && blink.IsValid && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost
				})()

			if (hero.Distance2D(bestTarget) > castRange && !isBlinkKickReady) {
				continue
			}

			// Special Handling per spell type
			// 1. WALRUS KICK
			if (spellName === "tusk_walrus_kick") {
				// Find nearest teammate
				let kickTarget: Unit | undefined
				let minAllyDist = Infinity
				const searchRadius = this.allySearchRadius.value

				for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
					if (
						ally.IsValid &&
						ally.IsAlive &&
						ally !== hero &&
						!ally.IsEnemy(hero) &&
						!ally.IsIllusion &&
						hero.Distance2D(ally) <= searchRadius
					) {
						const dist = hero.Distance2D(ally)
						if (dist < minAllyDist) {
							minAllyDist = dist
							kickTarget = ally
						}
					}
				}

				// Fallback to team fountain
				if (!kickTarget) {
					kickTarget = EntityManager.GetEntitiesByClass(Fountain).find(f => f.IsValid && !f.IsEnemy(hero))
				}
				if (kickTarget) {
					const kickDirection = kickTarget.Position

					// Retrieve Blink item
					const blink =
						this.getItem(hero, "item_blink") ||
						this.getItem(hero, "item_swift_blink") ||
						this.getItem(hero, "item_overwhelming_blink") ||
						this.getItem(hero, "item_arcane_blink")
					const blinkEnabled = this.itemsSelector.IsEnabled("item_blink")
					const blinkReady =
						blink && blinkEnabled && blink.IsValid && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost

					if (blinkReady && hero.Distance2D(bestTarget) > 250) {
						const blinkPos = bestTarget.Position.Extend(hero.Position, 120)
						if (hero.Distance2D(blinkPos) <= 1200) {
							claimOrder()
							// Blink to range
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: blinkPos,
								ability: blink.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})

							// Vector target direction
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_VECTOR_TARGET_POSITION,
								issuers: [hero],
								ability: ability.Index,
								target: bestTarget.Index,
								position: kickDirection,
								queue: true,
								showEffects: true,
								isPlayerInput: false
							})

							// Cast Kick
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: ability.Index,
								queue: true,
								showEffects: true,
								isPlayerInput: false
							})

							this.sleeper.Sleep(GameState.InputLag * 1000 + 250)
							return
						}
					}

					// Direct kick with vector targeting (no blink or already in range)
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_VECTOR_TARGET_POSITION,
						issuers: [hero],
						ability: ability.Index,
						target: bestTarget.Index,
						position: kickDirection,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})

					if (this.executeComboAbility(hero, ability, bestTarget)) {
						this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
						return
					}
				}

				// Fallback
				if (this.executeComboAbility(hero, ability, bestTarget)) {
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

			// 2. ICE SHARDS (Predictive Lead Calculation)
			if (spellName === "tusk_ice_shards") {
				const shardSpeed = 1200
				const castPoint = ability.CastPoint > 0 ? ability.CastPoint : 0.2
				const inputLag = GameState.InputLag || 0.03
				const turnTime = hero.GetTurnTime ? hero.GetTurnTime(bestTarget.Position) : 0
				const dist = hero.Distance2D(bestTarget)
				const flightTime = dist / shardSpeed
				const totalDelay = turnTime + castPoint + flightTime + inputLag

				let shardsTargetPos = bestTarget.Position.Clone()
				if (
					bestTarget.IsMoving &&
					!bestTarget.IsStunned &&
					!bestTarget.IsRooted &&
					!bestTarget.IsHexed &&
					!bestTarget.IsChanneling
				) {
					shardsTargetPos = bestTarget.GetPredictionPosition(totalDelay)
				}

				if (this.executeComboAbility(hero, ability, bestTarget, true, shardsTargetPos)) {
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

			// 3. TAG TEAM (Trigger within close combat range)
			if (spellName === "tusk_tag_team") {
				const tagTeamRange = 450
				if (hero.Distance2D(bestTarget) <= tagTeamRange || isInsideSnowball) {
					if (this.executeComboAbility(hero, ability, bestTarget)) {
						this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
						return
					}
				}
				continue
			}

			// 4. DRINKING BUDDIES (Friendly target assist)
			if (spellName === "tusk_drinking_buddies") {
				let buddiesTarget: Hero | undefined
				let minAllyDist = Infinity
				const buddiesRange = ability.CastRange > 0 ? ability.CastRange : 900

				for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
					if (
						ally.IsValid &&
						ally.IsAlive &&
						ally !== hero &&
						!ally.IsEnemy(hero) &&
						!ally.IsIllusion &&
						hero.Distance2D(ally) <= buddiesRange
					) {
						const dist = hero.Distance2D(ally)
						if (dist < minAllyDist) {
							minAllyDist = dist
							buddiesTarget = ally
						}
					}
				}

				if (buddiesTarget) {
					if (this.executeComboAbility(hero, ability, buddiesTarget)) {
						this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
						return
					}
				}
				continue
			}

			// 5. WALRUS PUNCH & SNOWBALL
			if (spellName === "tusk_walrus_punch") {
				const attackRange = hero.GetAttackRange(bestTarget) + 60
				if (hero.Distance2D(bestTarget) <= attackRange) {
					if (this.executeComboAbility(hero, ability, bestTarget)) {
						this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
						return
					}
				}
				continue
			}

			// Standard Cast for Snowball
			if (this.executeComboAbility(hero, ability, bestTarget)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return
			}
		}

		// Fallback to Orb Walk (Melee forward chase & bodyblock)
		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}
})()
