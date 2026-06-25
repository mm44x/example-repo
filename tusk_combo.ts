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

new (class TuskCombo {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Combo Heroes").AddNode("Tusk Combo")

	// Enable/Disable combo
	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Tusk combo script")

	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Tusk combo")
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

	// Items selection
	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		["item_blink"],
		new Map([["item_blink", true]]),
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
	private readonly pullSleeper = new TickSleeper()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("tusk_walrus_kick", [true, true, true, 0])
		defaultCombo.set("tusk_snowball", [true, true, true, 1])
		defaultCombo.set("tusk_ice_shards", [true, true, true, 2])
		defaultCombo.set("tusk_tag_team", [true, true, true, 3])
		defaultCombo.set("tusk_walrus_punch", [true, true, true, 4])
		defaultCombo.set("tusk_drinking_buddies", [true, true, true, 5])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			[
				"tusk_walrus_kick",
				"tusk_snowball",
				"tusk_ice_shards",
				"tusk_tag_team",
				"tusk_walrus_punch",
				"tusk_drinking_buddies"
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
			LocalPlayer.Hero.Name === "npc_dota_hero_tusk"
		)
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

		// Check if we are inside the Snowball
		const isInsideSnowball =
			hero.HasBuffByName("modifier_tusk_snowball_movement") ||
			hero.HasBuffByName("modifier_tusk_snowball_visible")

		if (isInsideSnowball) {
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
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_TARGET,
							issuers: [hero],
							target: ally.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.pullSleeper.Sleep(150)
						break
					}
				}
			}

			// Launch snowball immediately if visible
			const launch = hero.GetAbilityByName("tusk_launch_snowball")
			if (launch && launch.IsValid && !launch.IsHidden && launch.Level > 0 && launch.Cooldown <= 0.1) {
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

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

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
			if (isTargetImmune && spellName !== "tusk_walrus_punch") {
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
					const blink = hero.Items.find(
						item =>
							item.Name === "item_blink" ||
							item.Name === "item_swift_blink" ||
							item.Name === "item_overwhelming_blink" ||
							item.Name === "item_arcane_blink"
					)
					return blink && blink.IsValid && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost
				})()

			if (hero.Distance2D(bestTarget) > castRange && !isBlinkKickReady) {
				continue
			}

			// Special Handling per spell type
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
					// Absolute position pointing to kickTarget
					const kickDirection = kickTarget.Position

					// Retrieve Blink item
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

					if (blinkReady) {
						// Position Tusk 150 units away from the enemy towards Tusk's own position
						const blinkPos = bestTarget.Position.Extend(hero.Position, 150)
						if (hero.Distance2D(blinkPos) <= 1200) {
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

							console.log("[TuskCombo] Blink + Vector Walrus Kick executed!")
							this.sleeper.Sleep(GameState.InputLag * 1000 + 300)
							return
						}
					}

					// Direct kick with vector targeting (no blink)
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
						console.log("[TuskCombo] Direct Vector Walrus Kick casted!")
						this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
						return
					}
				}

				// Ultimate fallback
				if (this.executeComboAbility(hero, ability, bestTarget)) {
					console.log("[TuskCombo] Fallback Walrus Kick casted!")
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

			if (spellName === "tusk_ice_shards") {
				const shardsTargetPos = bestTarget.Position.Add(
					bestTarget.Forward.MultiplyScalar(bestTarget.IsMoving ? 250 : 100)
				)

				if (this.executeComboAbility(hero, ability, bestTarget, true, shardsTargetPos)) {
					console.log("[TuskCombo] Ice Shards casted predictively!")
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

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
						console.log("[TuskCombo] Drinking Buddies casted on friendly hero:", buddiesTarget.Name)
						this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
						return
					}
				}
				continue // Skip if no ally found in range
			}

			// Standard Cast for Snowball, Tag Team, Walrus Punch
			if (this.executeComboAbility(hero, ability, bestTarget)) {
				console.log(`[TuskCombo] Casted spell: ${spellName}`)
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
