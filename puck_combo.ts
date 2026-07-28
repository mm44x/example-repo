import {
	Ability,
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
	TickSleeper,
	Unit,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { executeOrbwalk } from "./orbwalker"

new (class PuckCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Puck Combo", "panorama/images/heroes/icons/npc_dota_hero_puck_png.vtex_c", "", 0)

	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Puck combo script")
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Puck combo")
	
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"If enabled, locks onto a single target hero when pressing the combo key."
	)
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)

	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		["item_blink", "item_sheepstick", "item_dagon", "item_shivas_guard"],
		new Map([
			["item_blink", true],
			["item_sheepstick", true],
			["item_dagon", true],
			["item_shivas_guard", true]
		]),
		"Toggle item usage in the combo"
	)

	private readonly smartOrbWalkEnabled = this.entry.AddToggle("Enable Smart Orb Walk", true)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider("Orb Walk Safe Distance %", 80, 10, 100, 5)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle("Stop-to-Cancel Backswing", false)

	private comboSequenceGrid: any
	private lockedTarget: Hero | undefined = undefined

	private readonly sleeper = new TickSleeper()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("item_blink", [true, true, true, 0])
		defaultCombo.set("puck_dream_coil", [true, true, true, 1])
		defaultCombo.set("puck_waning_rift", [true, true, true, 2])
		defaultCombo.set("puck_illusory_orb", [true, true, true, 3])
		defaultCombo.set("puck_phase_shift", [true, true, true, 4])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			[
				"item_blink",
				"puck_dream_coil",
				"puck_waning_rift",
				"puck_illusory_orb",
				"puck_phase_shift"
			],
			defaultCombo
		)

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero() {
		return (
			LocalPlayer &&
			LocalPlayer.Hero &&
			LocalPlayer.Hero.IsValid &&
			LocalPlayer.Hero.Name === "npc_dota_hero_puck"
		)
	}

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
		this.comboSequenceGrid = null
		this.lockedTarget = undefined
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

		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed || hero.HasBuffByName("modifier_puck_phase_shift")) {
			return
		}

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
				const maxCastRange = 1200
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
				if (foundTarget) {
					this.lockedTarget = foundTarget
				}
			}
			bestTarget = this.lockedTarget
		} else {
			const maxCastRange = 1200
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
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// Execute Item Combos first (if any besides blink)
		if (!isTargetImmune) {
			if (this.itemsSelector.IsEnabled("item_sheepstick") && hero.Distance2D(bestTarget) <= 850) {
				const hex = hero.Items.find(i => i.Name === "item_sheepstick")
				if (hex && hex.IsValid && hex.Cooldown <= 0.1 && hex.CanBeUsable && !hero.IsMuted && hero.Mana >= hex.ManaCost) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: hex.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + hex.CastPoint * 1000 + 100)
					return
				}
			}
			
			// Try Dagon
			if (this.itemsSelector.IsEnabled("item_dagon")) {
				const dagon = hero.Items.find(i => i.Name.startsWith("item_dagon"))
				if (dagon && dagon.IsValid && dagon.Cooldown <= 0.1 && dagon.CanBeUsable && !hero.IsMuted && hero.Mana >= dagon.ManaCost) {
					const r = dagon.CastRange > 0 ? dagon.CastRange : 800
					if (hero.Distance2D(bestTarget) <= r) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: dagon.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + dagon.CastPoint * 1000 + 100)
						return
					}
				}
			}
		}

		// Execute Combo Sequence
		for (const spellName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			// Item Blink
			if (spellName === "item_blink") {
				const blinkEnabled = this.itemsSelector.IsEnabled("item_blink")
				if (blinkEnabled) {
					const blink = hero.Items.find(
						item =>
							item.Name === "item_blink" ||
							item.Name === "item_swift_blink" ||
							item.Name === "item_overwhelming_blink" ||
							item.Name === "item_arcane_blink"
					)
					
					if (blink && blink.IsValid && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost && !hero.IsMuted) {
						const dist = hero.Distance2D(bestTarget)
						if (dist > 400 && dist <= 1200) {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: bestTarget.Position,
								ability: blink.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
							return
						}
					}
				}
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

			if (isTargetImmune && spellName !== "puck_dream_coil") {
				continue // Dream coil pierces BKB in some cases or is commonly thrown anyway.
			}

			// Special Handling: Illusory Orb (towards fountain, check vector target)
			if (spellName === "puck_illusory_orb") {
				// Cast towards team fountain
				const friendlyFountain = EntityManager.GetEntitiesByClass(Fountain).find(f => f.IsValid && !f.IsEnemy(hero))
				const fountainPos = friendlyFountain
					? friendlyFountain.Position.Clone()
					: (hero.Team === 2 ? new Vector3(-7400, -7300, 512) : new Vector3(7400, 7300, 512))
				
				const dir = fountainPos.Subtract(hero.Position).Normalize()
				// Cap distance to prevent walking
				const castPos = hero.Position.Add(dir.MultiplyScalar(500))
				// Extend the direction for the vector curve endpoint
				const curveEndPos = hero.Position.Add(dir.MultiplyScalar(1000))

				const isVectorTarget = ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_VECTOR_TARGETING)
				if (isVectorTarget) {
					// Set the curve direction
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_VECTOR_TARGET_POSITION,
						issuers: [hero],
						position: curveEndPos,
						ability: ability.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					
					// Execute the actual cast at the starting point
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: castPos,
						ability: ability.Index,
						queue: true,
						showEffects: true,
						isPlayerInput: false
					})
				} else {
					// Standard point target (e.g. Jostling Rift facet)
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: castPos,
						ability: ability.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
				
				console.log("[PuckCombo] Casted Illusory Orb towards Fountain")
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return
			}

			// Special Handling: Phase Shift
			if (spellName === "puck_phase_shift") {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: ability.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				console.log("[PuckCombo] Casted Phase Shift")
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return
			}

			// Standard Cast for Dream Coil, Waning Rift
			const castRange = ability.CastRange > 0 ? ability.CastRange : (spellName === "puck_waning_rift" ? 400 : 800)
			
			if (hero.Distance2D(bestTarget) > castRange) {
				continue
			}

			if (this.executeComboAbility(hero, ability, bestTarget)) {
				console.log(`[PuckCombo] Casted spell: ${spellName}`)
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return
			}
		}

		// Fallback to Orb Walk
		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}
})()
