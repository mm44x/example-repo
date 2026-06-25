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
	Item,
	LocalPlayer,
	Menu,
	TickSleeper,
	Unit,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { executeOrbwalk } from "./orbwalker"

new (class MagnusCombo {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Combo Heroes").AddNode("Magnus Combo")

	// Enable/Disable combo
	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Magnus combo script")

	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Magnus combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)
	private readonly allySearchRadius = this.entry.AddSlider(
		"Ally Search Distance (Skewer)",
		1500,
		500,
		3000,
		0,
		"Radius to search for teammates to skewer the enemy towards"
	)

	// Items selection
	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		["item_blink", "item_harpoon"],
		new Map([
			["item_blink", true],
			["item_harpoon", true]
		]),
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
		5,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle(
		"Stop-to-Cancel Backswing",
		false,
		"Use STOP before moving during backswing cancel for crisper animation break"
	)

	private comboSequenceGrid: any
	private lockedTarget: Hero | undefined = undefined

	// Sleepers
	private readonly sleeper = new TickSleeper()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("magnataur_shockwave", [true, true, true, 0])
		defaultCombo.set("magnataur_horn_toss", [true, true, true, 1])
		defaultCombo.set("magnataur_skewer", [true, true, true, 2])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			["magnataur_shockwave", "magnataur_horn_toss", "magnataur_skewer"],
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
			LocalPlayer.Hero.Name === "npc_dota_hero_magnataur"
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

		// Check combo hotkey
		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// Verify existing locked target
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

		// Target Selection (nearest to cursor) if not locked
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

		const bestTarget = this.lockedTarget
		if (!bestTarget) {
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		// Redirection target calculation (closest ally or fountain)
		let redirectionTarget: Unit | undefined
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
					redirectionTarget = ally
				}
			}
		}

		if (!redirectionTarget) {
			redirectionTarget = EntityManager.GetEntitiesByClass(Fountain).find(f => f.IsValid && !f.IsEnemy(hero))
		}

		if (!redirectionTarget) {
			return
		}

		// Items checks
		const blink = hero.Items.find(
			item =>
				item.Name === "item_blink" ||
				item.Name === "item_swift_blink" ||
				item.Name === "item_overwhelming_blink" ||
				item.Name === "item_arcane_blink"
		)
		const blinkEnabled = this.itemsSelector.IsEnabled("item_blink")
		const blinkReady =
			blink && blinkEnabled && blink.IsValid && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost

		const harpoon = hero.Items.find(item => item.Name === "item_harpoon")
		const harpoonEnabled = this.itemsSelector.IsEnabled("item_harpoon")
		const harpoonReady =
			harpoon && harpoonEnabled && harpoon.IsValid && harpoon.Cooldown <= 0.1 && hero.Mana >= harpoon.ManaCost

		// Abilities
		const shockwave = hero.GetAbilityByName("magnataur_shockwave")
		const hornToss = hero.GetAbilityByName("magnataur_horn_toss")
		const skewer = hero.GetAbilityByName("magnataur_skewer")

		const isShockwaveReady =
			shockwave &&
			shockwave.IsValid &&
			!shockwave.IsHidden &&
			shockwave.Level > 0 &&
			shockwave.Cooldown <= 0.1 &&
			hero.Mana >= shockwave.ManaCost &&
			this.comboSequenceGrid.IsEnabled("magnataur_shockwave")

		const isHornTossReady =
			hornToss &&
			hornToss.IsValid &&
			!hornToss.IsHidden &&
			hornToss.Level > 0 &&
			hornToss.Cooldown <= 0.1 &&
			hero.Mana >= hornToss.ManaCost &&
			this.comboSequenceGrid.IsEnabled("magnataur_horn_toss")

		const isSkewerReady =
			skewer &&
			skewer.IsValid &&
			!skewer.IsHidden &&
			skewer.Level > 0 &&
			skewer.Cooldown <= 0.1 &&
			hero.Mana >= skewer.ManaCost &&
			this.comboSequenceGrid.IsEnabled("magnataur_skewer")

		// 1. Blink Combo (choose one setup: Horn Toss > Harpoon > Shockwave)
		if (blinkReady && isSkewerReady) {
			const blinkPos = bestTarget.Position.Extend(redirectionTarget.Position, -150)
			const distToBlink = hero.Distance2D(blinkPos)

			if (distToBlink <= 1200) {
				let setupAbility: Ability | Item | undefined
				let setupType: "horn_toss" | "harpoon" | "shockwave" | undefined

				if (isHornTossReady) {
					setupAbility = hornToss
					setupType = "horn_toss"
				} else if (harpoonReady) {
					setupAbility = harpoon
					setupType = "harpoon"
				} else if (isShockwaveReady) {
					setupAbility = shockwave
					setupType = "shockwave"
				}

				if (setupAbility && setupType) {
					// Cast Blink
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: blinkPos,
						ability: blink.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})

					// Queue Setup Ability/Item
					if (setupType === "horn_toss") {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
							issuers: [hero],
							ability: setupAbility.Index,
							queue: true,
							showEffects: true,
							isPlayerInput: false
						})
					} else if (setupType === "harpoon") {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: setupAbility.Index,
							queue: true,
							showEffects: true,
							isPlayerInput: false
						})
					} else if (setupType === "shockwave") {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: bestTarget.Position,
							ability: setupAbility.Index,
							queue: true,
							showEffects: true,
							isPlayerInput: false
						})
					}

					// Queue Skewer towards redirection target
					const skewerRange = skewer.CastRange > 0 ? skewer.CastRange : 1200
					const skewerPos = blinkPos.Extend(redirectionTarget.Position, skewerRange)
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: skewerPos,
						ability: skewer.Index,
						queue: true,
						showEffects: true,
						isPlayerInput: false
					})

					console.log(`[MagnusCombo] Blink + ${setupType} + Skewer combo executed!`)
					this.sleeper.Sleep(GameState.InputLag * 1000 + 450)
					return
				}
			}
		}

		// 2. Harpoon + Skewer Combo (if Harpoon ready and Skewer/Horn Toss ready)
		if (harpoonReady && hero.Distance2D(bestTarget, true) <= 700) {
			// Cast Harpoon
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
				issuers: [hero],
				target: bestTarget.Index,
				ability: harpoon.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})

			console.log("[MagnusCombo] Harpoon executed!")
			// Sleep for 250ms to allow pull to bring them together
			this.sleeper.Sleep(250)
			return
		}

		// Execute custom ordered combo
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

			// Range check for direct casting (Blink not ready or other scenario)
			const castRange = ability.CastRange > 0 ? ability.CastRange : 800
			if (spellName !== "magnataur_horn_toss" && hero.Distance2D(bestTarget) > castRange) {
				continue
			}

			if (spellName === "magnataur_shockwave") {
				if (this.executeComboAbility(hero, ability, bestTarget, true)) {
					console.log("[MagnusCombo] Casted Shockwave directly!")
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

			if (spellName === "magnataur_horn_toss") {
				// Horn Toss flings enemies in 250 radius in front of Magnus
				if (hero.Distance2D(bestTarget) <= 275) {
					if (this.executeComboAbility(hero, ability, bestTarget)) {
						console.log("[MagnusCombo] Casted Horn Toss!")
						// Sleep slightly to let the 0.2s cast animation finish
						this.sleeper.Sleep(GameState.InputLag * 1000 + 200)
						return
					}
				}
			}

			if (spellName === "magnataur_skewer") {
				const skewerRange = ability.CastRange > 0 ? ability.CastRange : 1200
				const skewerPos = hero.Position.Extend(redirectionTarget.Position, skewerRange)
				if (this.executeComboAbility(hero, ability, bestTarget, true, skewerPos)) {
					console.log("[MagnusCombo] Casted Skewer!")
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
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
