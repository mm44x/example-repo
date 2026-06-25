import {
	Ability,
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
	Unit
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
	private lastComboTime = 0
	private currentSetup: "horn_toss" | "harpoon" | "shockwave" | "none" | undefined = undefined
	private comboStep: "idle" | "setup" | "skewer" = "idle"

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

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.comboSequenceGrid = null
		this.lockedTarget = undefined
		this.lastComboTime = 0
		this.currentSetup = undefined
		this.comboStep = "idle"
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
			this.currentSetup = undefined
			this.comboStep = "idle"
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
				this.currentSetup = undefined
				this.comboStep = "idle"
			}
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

		// Initialize setup type immediately when target is locked and setup isn't decided yet
		if (this.currentSetup === undefined) {
			if (isHornTossReady) {
				this.currentSetup = "horn_toss"
			} else if (harpoonReady) {
				this.currentSetup = "harpoon"
			} else if (isShockwaveReady) {
				this.currentSetup = "shockwave"
			} else {
				this.currentSetup = "none"
			}
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

		// 1. Skewer Combo Execution (Step-by-step)
		if (isSkewerReady && Date.now() - this.lastComboTime > 2000) {
			const setupType = this.currentSetup || "none"
			let setupAbility: Ability | Item | undefined
			if (setupType === "horn_toss") {
				setupAbility = hornToss
			} else if (setupType === "harpoon") {
				setupAbility = harpoon
			} else if (setupType === "shockwave") {
				setupAbility = shockwave
			}

			// Validate chosen setup readiness when starting combo
			let setupReady = false
			if (setupType === "horn_toss" && isHornTossReady) {
				setupReady = true
			} else if (setupType === "harpoon" && harpoonReady) {
				setupReady = true
			} else if (setupType === "shockwave" && isShockwaveReady) {
				setupReady = true
			} else if (setupType === "none") {
				setupReady = true
			}

			if (this.comboStep === "idle") {
				if (!setupReady) {
					// Chosen setup is not ready, do not initiate combo
					return
				}

				if (blinkReady) {
					const blinkPos = bestTarget.Position.Extend(redirectionTarget.Position, -150)
					if (hero.Distance2D(blinkPos) <= 1200) {
						// Step 1: Blink
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: blinkPos,
							ability: blink.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.comboStep = "setup"
						console.log("[MagnusCombo] Step 1: Casted Blink")
						this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
						return
					}
				}

				// If Blink not ready, too far, or not owned, do direct setup
				if (setupAbility) {
					const castRange =
						setupAbility.CastRange > 0 ? setupAbility.CastRange : setupType === "horn_toss" ? 275 : 800
					if (hero.Distance2D(bestTarget) <= castRange) {
						// Direct Setup
						if (setupType === "horn_toss") {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
								issuers: [hero],
								ability: setupAbility.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
						} else if (setupType === "harpoon") {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: setupAbility.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
						} else if (setupType === "shockwave") {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: bestTarget.Position,
								ability: setupAbility.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
						}
						this.comboStep = "skewer"
						console.log(`[MagnusCombo] Direct: Casted Setup ${setupType}`)
						this.sleeper.Sleep(GameState.InputLag * 1000 + setupAbility.CastPoint * 1000 + 100)
						return
					}
				} else if (hero.Distance2D(bestTarget) <= 150) {
					// No setup, direct Skewer
					const skewerRange = skewer.CastRange > 0 ? skewer.CastRange : 1200
					const skewerPos = hero.Position.Extend(redirectionTarget.Position, skewerRange)
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: skewerPos,
						ability: skewer.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					console.log("[MagnusCombo] Direct: Casted Skewer")
					this.lastComboTime = Date.now()
					this.comboStep = "idle"
					this.sleeper.Sleep(GameState.InputLag * 1000 + 1500)
					return
				}
			}

			if (this.comboStep === "setup") {
				if (setupAbility) {
					// Step 2: Cast Setup
					if (setupType === "horn_toss") {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
							issuers: [hero],
							ability: setupAbility.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					} else if (setupType === "harpoon") {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: setupAbility.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					} else if (setupType === "shockwave") {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: bestTarget.Position,
							ability: setupAbility.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
					}
					this.comboStep = "skewer"
					console.log(`[MagnusCombo] Step 2: Casted Setup ${setupType}`)
					this.sleeper.Sleep(GameState.InputLag * 1000 + setupAbility.CastPoint * 1000 + 100)
					return
				}
				// No setup, go directly to Skewer step
				this.comboStep = "skewer"
			}

			if (this.comboStep === "skewer") {
				// Step 3: Cast Skewer
				const skewerRange = skewer.CastRange > 0 ? skewer.CastRange : 1200
				const skewerPos = hero.Position.Extend(redirectionTarget.Position, skewerRange)
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: skewerPos,
					ability: skewer.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				console.log("[MagnusCombo] Step 3: Casted Skewer")
				this.lastComboTime = Date.now()
				this.comboStep = "idle"
				this.sleeper.Sleep(GameState.InputLag * 1000 + 1500)
				return
			}
		}

		// 2. Post-Initiation Spells Spam (if Skewer is on cooldown/not ready)
		if (!isSkewerReady) {
			if (isHornTossReady && hornToss && hero.Distance2D(bestTarget) <= 275) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: hornToss.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				console.log("[MagnusCombo] Spammed Horn Toss!")
				this.sleeper.Sleep(GameState.InputLag * 1000 + hornToss.CastPoint * 1000 + 100)
				return
			}

			if (harpoonReady && harpoon && hero.Distance2D(bestTarget) <= 800) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: harpoon.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				console.log("[MagnusCombo] Spammed Harpoon!")
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}

			if (isShockwaveReady && shockwave && hero.Distance2D(bestTarget) <= 1200) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: bestTarget.Position,
					ability: shockwave.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				console.log("[MagnusCombo] Spammed Shockwave!")
				this.sleeper.Sleep(GameState.InputLag * 1000 + shockwave.CastPoint * 1000 + 100)
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
