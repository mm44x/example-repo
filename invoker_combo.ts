import {
	Ability,
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
	TickSleeper,
	Unit,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { executeOrbwalk } from "./orbwalker"

const SPELL_ORBS: Record<string, string[]> = {
	invoker_cold_snap: ["quas", "quas", "quas"],
	invoker_ghost_walk: ["quas", "quas", "wex"],
	invoker_ice_wall: ["quas", "quas", "exort"],
	invoker_emp: ["wex", "wex", "wex"],
	invoker_tornado: ["wex", "wex", "quas"],
	invoker_alacrity: ["wex", "wex", "exort"],
	invoker_sun_strike: ["exort", "exort", "exort"],
	invoker_chaos_meteor: ["exort", "exort", "wex"],
	invoker_forge_spirit: ["exort", "exort", "quas"],
	invoker_deafening_blast: ["quas", "wex", "exort"]
}

new (class InvokerCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Invoker Combo", "panorama/images/heroes/icons/npc_dota_hero_invoker_png.vtex_c", "", 0)

	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Invoker combo script")
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Invoker combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)

	private readonly useCataclysm = this.entry.AddToggle(
		"Use Cataclysm",
		true,
		"Automatically toggle Alt-Cast for Sun Strike to use Cataclysm if Aghanim's is active"
	)

	private readonly scepterUpgrade = this.entry.AddDropdown(
		"Aghanim Scepter Upgrade Mode",
		["Exort Upgrade (Cataclysm)", "Quas Upgrade (Ice Wall Ground Target)", "Wex Upgrade / None"],
		0,
		"Select which upgrade/facet you took for Aghanim's Scepter"
	)

	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		["item_blink", "item_cyclone", "item_wind_waker", "item_sheepstick", "item_orchid", "item_bloodthorn", "item_nullifier", "item_urn_of_shadows", "item_spirit_vessel", "item_shivas_guard", "item_refresher"],
		new Map([
			["item_blink", true],
			["item_cyclone", true],
			["item_wind_waker", true],
			["item_sheepstick", true],
			["item_orchid", true],
			["item_bloodthorn", true],
			["item_nullifier", true],
			["item_urn_of_shadows", true],
			["item_spirit_vessel", true],
			["item_shivas_guard", true],
			["item_refresher", true]
		]),
		"Toggle item usage in the combo"
	)

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
	private readonly sleeper = new TickSleeper()

	private disruptNode: any = null
	private enableDisrupt: any = null
	private disruptSkills: any = null
	private disruptInvis: any = null

	private autoSkillNode: any = null
	private autoSkillConfigs: Map<string, { key: any; mode: any }> = new Map()
	private pendingAutoSkill: string | null = null
	private autoSkillCursorPos: Vector3 | null = null

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("invoker_tornado", [true, true, true, 0])
		defaultCombo.set("invoker_emp", [true, true, true, 1])
		defaultCombo.set("invoker_chaos_meteor", [true, true, true, 2])
		defaultCombo.set("invoker_deafening_blast", [true, true, true, 3])
		defaultCombo.set("invoker_cold_snap", [true, true, true, 4])
		defaultCombo.set("invoker_sun_strike", [true, true, true, 5])
		defaultCombo.set("invoker_ice_wall", [true, true, true, 6])
		defaultCombo.set("invoker_alacrity", [true, true, true, 7])
		defaultCombo.set("invoker_forge_spirit", [true, true, true, 8])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			[
				"invoker_tornado",
				"invoker_emp",
				"invoker_chaos_meteor",
				"invoker_deafening_blast",
				"invoker_cold_snap",
				"invoker_sun_strike",
				"invoker_ice_wall",
				"invoker_alacrity",
				"invoker_forge_spirit"
			],
			defaultCombo
		)

		// Build Auto Skill submenu for each spell
		this.autoSkillNode = this.entry.AddNode(
			"Auto Skill",
			"panorama/images/heroes/icons/npc_dota_hero_invoker_png.vtex_c",
			"",
			0
		)
		const autoSkillSpells = [
			"Cold Snap",
			"Ghost Walk",
			"Ice Wall",
			"EMP",
			"Tornado",
			"Alacrity",
			"Sun Strike",
			"Chaos Meteor",
			"Forge Spirit",
			"Deafening Blast"
		]
		const autoSkillInternalNames = [
			"invoker_cold_snap",
			"invoker_ghost_walk",
			"invoker_ice_wall",
			"invoker_emp",
			"invoker_tornado",
			"invoker_alacrity",
			"invoker_sun_strike",
			"invoker_chaos_meteor",
			"invoker_forge_spirit",
			"invoker_deafening_blast"
		]
		for (let i = 0; i < autoSkillSpells.length; i++) {
			const displayName = autoSkillSpells[i]
			const internalName = autoSkillInternalNames[i]
			const icon = `panorama/images/spellicons/${internalName}_png.vtex_c`
			const spellNode = this.autoSkillNode.AddNode(
				displayName,
				icon,
				"",
				0
			)
			const hotkey = spellNode.AddKeybind(
				"Hotkey",
				"",
				`Hotkey to trigger ${displayName}`
			)
			const mode = spellNode.AddDropdown(
				"Mode",
				["Auto Use", "Only Craft"],
				0,
				"Auto Use: invoke + cast immediately. Only Craft: prepare spell for manual use."
			)
			this.autoSkillConfigs.set(internalName, { key: hotkey, mode })
		}

		// Auto Disrupt Channeling
		this.disruptNode = this.entry.AddNode(
			"Auto Disrupt",
			"panorama/images/spellicons/invoker_cold_snap_png.vtex_c",
			"",
			0
		)
		this.enableDisrupt = this.disruptNode.AddToggle(
			"Enable Auto Disrupt",
			true,
			"Auto cancel enemy channeling (TP, Enigma ult, etc.) using Cold Snap (close) or Tornado (far)"
		)
		this.disruptSkills = this.disruptNode.AddImageSelector(
			"Disrupt Skills",
			["invoker_cold_snap", "invoker_tornado"],
			new Map([
				["invoker_cold_snap", true],
				["invoker_tornado", true]
			]),
			"Toggle which skills to use for disrupting"
		)
		this.disruptInvis = this.disruptNode.AddToggle(
			"Disrupt in Invis",
			false,
			"Allow auto disrupt while Invoker is invisible (Ghost Walk, Shadow Blade, etc.)"
		)

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero() {
		return (
			LocalPlayer &&
			LocalPlayer.Hero &&
			LocalPlayer.Hero.IsValid &&
			LocalPlayer.Hero.Name === "npc_dota_hero_invoker"
		)
	}

	private hasScepter(hero: Hero): boolean {
		return (
			hero.HasBuffByName("modifier_item_ultimate_scepter") ||
			hero.HasBuffByName("modifier_item_ultimate_scepter_consumed")
		)
	}

	private isIceWallUpgraded(hero: Hero): boolean {
		return this.hasScepter(hero) && this.scepterUpgrade.SelectedID === 1
	}

	private isSunStrikeUpgraded(hero: Hero): boolean {
		return this.hasScepter(hero) && this.scepterUpgrade.SelectedID === 0
	}

	private angleDifference(a: number, b: number): number {
		let diff = a - b
		while (diff < -Math.PI) diff += Math.PI * 2
		while (diff > Math.PI) diff -= Math.PI * 2
		return diff
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

	private useTargetItem(hero: Hero, itemName: string, target: Hero | Unit): boolean {
		if (!this.itemsSelector.IsEnabled(itemName)) {
			return false
		}
		const item = hero.Items.find(i => i.Name === itemName)
		if (item && item.IsValid && item.Cooldown <= 0.1 && hero.Mana >= item.ManaCost) {
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
				issuers: [hero],
				target: target.Index,
				ability: item.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		}
		return false
	}

	private useNoTargetItem(hero: Hero, itemName: string): boolean {
		if (!this.itemsSelector.IsEnabled(itemName)) {
			return false
		}
		const item = hero.Items.find(i => i.Name === itemName)
		if (item && item.IsValid && item.Cooldown <= 0.1 && hero.Mana >= item.ManaCost) {
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
				issuers: [hero],
				ability: item.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			return true
		}
		return false
	}

	private invokeSpell(hero: Hero, spellName: string, invokeAbility: Ability): boolean {
		const orbs = SPELL_ORBS[spellName]
		if (!orbs) return false

		for (const orbName of orbs) {
			const orbAbility = hero.GetAbilityByName(`invoker_${orbName}`)
			if (orbAbility && orbAbility.Level > 0) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: orbAbility.Index,
					queue: false,
					showEffects: false,
					isPlayerInput: false
				})
			}
		}

		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
			issuers: [hero],
			ability: invokeAbility.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})

		return true
	}

	private castInvokerSpell(
		hero: Hero,
		ability: Ability,
		target: Hero,
		liftBuff: any
	): boolean {
		const name = ability.Name

		// 1. If target is lifted in the air by Tornado or Cyclone
		if (liftBuff) {
			const rem = liftBuff.RemainingTime
			const castPoint = ability.CastPoint
			const delayBuffer = GameState.InputLag

			if (name === "invoker_sun_strike") {
				const ssDelay = 1.7
				const triggerTime = ssDelay + castPoint + delayBuffer
				if (rem <= triggerTime) {
					const wantCataclysm = this.useCataclysm.value && this.isSunStrikeUpgraded(hero)
					if (wantCataclysm) {
						if (!ability.AltCastState) {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT,
								issuers: [hero],
								ability: ability.Index,
								queue: false,
								showEffects: false,
								isPlayerInput: false
							})
						}
					} else {
						if (ability.AltCastState) {
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT,
								issuers: [hero],
								ability: ability.Index,
								queue: false,
								showEffects: false,
								isPlayerInput: false
							})
						}
					}
					
					if (this.executeComboAbility(hero, ability, target, true, target.Position)) {
						console.log("[InvokerCombo] Timed Sun Strike / Cataclysm casted!")
						this.sleeper.Sleep(delayBuffer * 1000 + castPoint * 1000 + 100)
						return true
					}
				}
				return false
			}

			if (name === "invoker_chaos_meteor") {
				const cmDelay = 1.3
				const triggerTime = cmDelay + castPoint + delayBuffer
				if (rem <= triggerTime) {
					const meteorPos = target.Position.Add(target.Forward.MultiplyScalar(target.IsMoving ? 150 : 0))
					if (this.executeComboAbility(hero, ability, target, true, meteorPos)) {
						console.log("[InvokerCombo] Timed Chaos Meteor casted!")
						this.sleeper.Sleep(delayBuffer * 1000 + castPoint * 1000 + 100)
						return true
					}
				}
				return false
			}

			if (name === "invoker_deafening_blast") {
				const dist = hero.Distance2D(target)
				const travelTime = dist / 1100
				const triggerTime = travelTime + castPoint + delayBuffer
				if (rem <= triggerTime) {
					if (this.executeComboAbility(hero, ability, target, true, target.Position)) {
						console.log("[InvokerCombo] Timed Deafening Blast casted!")
						this.sleeper.Sleep(delayBuffer * 1000 + castPoint * 1000 + 100)
						return true
					}
				}
				return false
			}

			if (name === "invoker_emp") {
				if (this.executeComboAbility(hero, ability, target, true, target.Position)) {
					console.log("[InvokerCombo] EMP casted immediately on lifted target!")
					this.sleeper.Sleep(delayBuffer * 1000 + castPoint * 1000 + 100)
					return true
				}
				return false
			}

			if (name === "invoker_ice_wall" && this.isIceWallUpgraded(hero)) {
				const triggerTime = 0.5 + castPoint + delayBuffer
				if (rem <= triggerTime) {
					if (this.executeComboAbility(hero, ability, target, true, target.Position)) {
						console.log("[InvokerCombo] Timed Upgraded Ice Wall casted under lifted target!")
						this.sleeper.Sleep(delayBuffer * 1000 + castPoint * 1000 + 100)
						return true
					}
				}
				return false
			}

			if (rem > 0.1) {
				return false
			}
		}

		// 2. Normal Cast (No lift buff active)
		if (name === "invoker_sun_strike") {
			const wantCataclysm = this.useCataclysm.value && this.isSunStrikeUpgraded(hero)
			if (wantCataclysm) {
				if (!ability.AltCastState) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT,
						issuers: [hero],
						ability: ability.Index,
						queue: false,
						showEffects: false,
						isPlayerInput: false
					})
				}
			} else {
				if (ability.AltCastState) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT,
						issuers: [hero],
						ability: ability.Index,
						queue: false,
						showEffects: false,
						isPlayerInput: false
					})
				}
			}
			const ssPos = target.Position.Add(target.Forward.MultiplyScalar(target.IsMoving ? 150 : 0))
			if (this.executeComboAbility(hero, ability, target, true, ssPos)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else if (name === "invoker_chaos_meteor") {
			const meteorPos = target.Position.Add(target.Forward.MultiplyScalar(target.IsMoving ? 150 : 0))
			if (this.executeComboAbility(hero, ability, target, true, meteorPos)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else if (name === "invoker_emp") {
			const empPos = target.Position.Add(target.Forward.MultiplyScalar(target.IsMoving ? 100 : 0))
			if (this.executeComboAbility(hero, ability, target, true, empPos)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else if (name === "invoker_tornado") {
			const tornadoPos = target.Position.Add(target.Forward.MultiplyScalar(target.IsMoving ? 200 : 0))
			if (this.executeComboAbility(hero, ability, target, true, tornadoPos)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else if (name === "invoker_ice_wall") {
			const upgraded = this.isIceWallUpgraded(hero)
			if (upgraded) {
				const isVector = ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_VECTOR_TARGETING)
				if (isVector) {
					const startPos = target.Position.Clone()
					const toTarget = target.Position.Subtract(hero.Position)
					const perp = new Vector3(-toTarget.y, toTarget.x, 0).Normalize()
					const endPos = startPos.Add(perp.MultiplyScalar(100))

					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_VECTOR_TARGET_POSITION,
						issuers: [hero],
						ability: ability.Index,
						position: endPos,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})

					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: startPos,
						ability: ability.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})

					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 150)
					return true
				} else {
					// Point-targeted ground spell (like Anti-Mage Blink)
					if (this.executeComboAbility(hero, ability, target, true, target.Position)) {
						this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
						return true
					}
				}
			} else {
				const dist = hero.Distance2D(target)
				if (dist <= 520) {
					const toTarget = target.Position.Subtract(hero.Position)
					const currentForward = hero.Forward
					const proj = toTarget.Dot(currentForward) // projection along forward

					// If we are already facing the target nicely (projection around 200)
					if (Math.abs(proj - 200) < 60) {
						if (this.executeComboAbility(hero, ability, target)) {
							this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
							return true
						}
					} else {
						// Calculate required turn angle
						const alpha = Math.atan2(toTarget.y, toTarget.x)
						const cosTheta = 200 / dist
						const clampedCos = Math.max(-1, Math.min(1, cosTheta))
						const theta = Math.acos(clampedCos)

						const phi1 = alpha + theta
						const phi2 = alpha - theta

						const currentAngle = Math.atan2(currentForward.y, currentForward.x)
						const diff1 = Math.abs(this.angleDifference(phi1, currentAngle))
						const diff2 = Math.abs(this.angleDifference(phi2, currentAngle))
						const bestPhi = diff1 < diff2 ? phi1 : phi2

						const faceDir = new Vector3(Math.cos(bestPhi), Math.sin(bestPhi), 0)
						const facePos = hero.Position.Add(faceDir.MultiplyScalar(100))

						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
							issuers: [hero],
							position: facePos,
							queue: false,
							showEffects: false,
							isPlayerInput: false
						})

						this.sleeper.Sleep(100)
						return true
					}
				}
			}
		} else if (name === "invoker_alacrity") {
			if (this.executeComboAbility(hero, ability, hero)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else if (name === "invoker_cold_snap") {
			if (this.executeComboAbility(hero, ability, target)) {
				console.log("[InvokerCombo] Casted Cold Snap!")
				this.useTargetItem(hero, "item_urn_of_shadows", target)
				this.useTargetItem(hero, "item_spirit_vessel", target)
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else {
			if (this.executeComboAbility(hero, ability, target)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		}

		return false
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.comboSequenceGrid = null
		this.lockedTarget = undefined
		this.pendingAutoSkill = null
		this.autoSkillCursorPos = null
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
		}

		// --- Auto Skill Handling ---
		if (!hero.IsChanneling && !hero.IsStunned && !hero.IsSilenced && !hero.IsHexed) {
		for (const [spellName, config] of this.autoSkillConfigs) {
			// @ts-ignore
			if (!config.key.isPressed) {
				continue
			}

			const ability = hero.GetAbilityByName(spellName)
			if (!ability || !ability.IsValid || ability.Level <= 0) {
				continue
			}

			const invokeAbility = hero.GetAbilityByName("invoker_invoke")
			const isActive = !ability.IsHidden
			const modeAutoUse = config.mode.SelectedID === 0 // 0 = Auto Use, 1 = Only Craft

			if (!isActive) {
				// Need to invoke first
				if (!invokeAbility || !invokeAbility.IsValid || invokeAbility.Cooldown > 0.1 || hero.Mana < invokeAbility.ManaCost) {
					continue
				}
				if (this.invokeSpell(hero, spellName, invokeAbility)) {
					if (modeAutoUse) {
						this.pendingAutoSkill = spellName
						this.autoSkillCursorPos = InputManager.CursorOnWorld
						console.log(`[InvokerCombo] Auto Skill: Invoked ${spellName}, pending cast`)
					} else {
						console.log(`[InvokerCombo] Auto Skill: Only Craft ${spellName}`)
					}
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
				continue
			}

			// Spell is active
			if (!modeAutoUse) {
				continue
			}

			// Auto Use: cast the active spell
			if (ability.Cooldown > 0.1 || hero.Mana < ability.ManaCost) {
				continue
			}

			const cursorPos = InputManager.CursorOnWorld

			if (ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: ability.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				console.log(`[InvokerCombo] Auto Skill: Cast ${spellName} (no target)`)
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				this.pendingAutoSkill = null
				this.autoSkillCursorPos = null
				return
			}

			if (ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
				const isSelfCast = spellName === "invoker_alacrity"
				const castTarget = isSelfCast ? hero : (() => {
					const enemies = EntityManager.GetEntitiesByClass(Hero)
					let best: Hero | undefined
					let minDist = Infinity
					for (const enemy of enemies) {
						if (enemy.IsEnemy(hero) && enemy.IsAlive && enemy.IsVisible && !enemy.IsIllusion) {
							const d = enemy.Position.Distance2D(cursorPos)
							if (d < 800 && d < minDist) {
								best = enemy
								minDist = d
							}
						}
					}
					return best
				})()

				if (castTarget) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: castTarget.Index,
						ability: ability.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					console.log(`[InvokerCombo] Auto Skill: Cast ${spellName} on target`)
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					this.pendingAutoSkill = null
					this.autoSkillCursorPos = null
					return
				}
				continue
			}

			// Point-targeted spell
			{
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: cursorPos,
					ability: ability.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				console.log(`[InvokerCombo] Auto Skill: Cast ${spellName} at cursor`)
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				this.pendingAutoSkill = null
				this.autoSkillCursorPos = null
				return
			}
		}

		} // end channeling/stunned check

		// --- Pending Auto Skill Cast ---
		if (this.pendingAutoSkill && !hero.IsChanneling && !hero.IsStunned && !hero.IsSilenced && !hero.IsHexed) {
			const ability = hero.GetAbilityByName(this.pendingAutoSkill)
			if (ability && ability.IsValid && !ability.IsHidden && ability.Cooldown <= 0.1 && hero.Mana >= ability.ManaCost) {
				const cursorPos = this.autoSkillCursorPos ?? InputManager.CursorOnWorld

				if (ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: ability.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					console.log(`[InvokerCombo] Auto Skill: Cast pending ${this.pendingAutoSkill} (no target)`)
				} else if (ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
					const isSelfCast = this.pendingAutoSkill === "invoker_alacrity"
					const castTarget = isSelfCast ? hero : (() => {
						const enemies = EntityManager.GetEntitiesByClass(Hero)
						let best: Hero | undefined
						let minDist = Infinity
						for (const enemy of enemies) {
							if (enemy.IsEnemy(hero) && enemy.IsAlive && enemy.IsVisible && !enemy.IsIllusion) {
								const d = enemy.Position.Distance2D(cursorPos)
								if (d < 800 && d < minDist) {
									best = enemy
									minDist = d
								}
							}
						}
						return best
					})()

					if (castTarget) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: castTarget.Index,
							ability: ability.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						console.log(`[InvokerCombo] Auto Skill: Cast pending ${this.pendingAutoSkill} on target`)
					}
				} else {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: cursorPos,
						ability: ability.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					console.log(`[InvokerCombo] Auto Skill: Cast pending ${this.pendingAutoSkill} at cursor`)
				}

				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
			}
			this.pendingAutoSkill = null
			this.autoSkillCursorPos = null
			return
		}

		// --- Auto Disrupt Channeling ---
		if (this.enableDisrupt && !hero.IsChanneling && !hero.IsStunned && !hero.IsSilenced && !hero.IsHexed && !this.sleeper.Sleeping) {
			if (!this.disruptInvis.value && hero.IsInvisible) {
				return
			}

			let disruptTarget: Hero | undefined
			let minDist = Infinity
			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (
					enemy.IsEnemy(hero) &&
					enemy.IsAlive &&
					!enemy.IsIllusion &&
					!enemy.IsMagicImmune
				) {
					const isChanneling =
						enemy.IsChanneling ||
						enemy.Buffs.some(b =>
							b.Name === "modifier_teleporting" ||
							b.Name.startsWith("modifier_enigma_black_hole") ||
							b.Name.startsWith("modifier_pudge_dismember") ||
							b.Name.startsWith("modifier_shadow_shaman_shackles") ||
							b.Name.startsWith("modifier_bane_fiends_grip") ||
							b.Name.startsWith("modifier_crystal_maiden_freezing_field") ||
							b.Name.startsWith("modifier_witch_doctor_voodoo_swtich") ||
							b.Name.startsWith("modifier_sandking_epicenter_channel") ||
							b.Name.startsWith("modifier_monkey_king_primal_spring") ||
							b.Name.startsWith("modifier_elder_titan_echo_stomp_channel") ||
							b.Name.startsWith("modifier_tinker_rearm")
						)

					if (!isChanneling) {
						continue
					}
					const dist = hero.Distance2D(enemy)
					if (dist < minDist) {
						minDist = dist
						disruptTarget = enemy
					}
				}
			}

			if (disruptTarget) {
				const useColdSnap = this.disruptSkills.IsEnabled("invoker_cold_snap")
				const useTornado = this.disruptSkills.IsEnabled("invoker_tornado")
				const invokeAbility = hero.GetAbilityByName("invoker_invoke")
				const canInvoke = invokeAbility && invokeAbility.IsValid && invokeAbility.Cooldown <= 0.1 && hero.Mana >= invokeAbility.ManaCost
				const coldSnapRange = 1000

				let chosenSpell = ""

				// Check Cold Snap availability (active or can be invoked)
				if (useColdSnap && minDist <= coldSnapRange) {
					const coldSnap = hero.GetAbilityByName("invoker_cold_snap")
					if (coldSnap && coldSnap.IsValid && coldSnap.Level > 0) {
						const csActive = !coldSnap.IsHidden && coldSnap.Cooldown <= 0.1 && hero.Mana >= coldSnap.ManaCost
						const csInvokable = coldSnap.IsHidden && canInvoke && coldSnap.Cooldown <= 0.1 && hero.Mana >= (coldSnap.ManaCost + invokeAbility.ManaCost)
						if (csActive || csInvokable) {
							chosenSpell = "invoker_cold_snap"
						}
					}
				}

				// Fallback to Tornado
				if (chosenSpell === "" && useTornado) {
					const tornado = hero.GetAbilityByName("invoker_tornado")
					if (tornado && tornado.IsValid && tornado.Level > 0) {
						const tActive = !tornado.IsHidden && tornado.Cooldown <= 0.1 && hero.Mana >= tornado.ManaCost
						const tInvokable = tornado.IsHidden && canInvoke && tornado.Cooldown <= 0.1 && hero.Mana >= (tornado.ManaCost + invokeAbility.ManaCost)
						if (tActive || tInvokable) {
							chosenSpell = "invoker_tornado"
						}
					}
				}

				if (chosenSpell !== "") {
					const ability = hero.GetAbilityByName(chosenSpell)
					const invokeAbility = hero.GetAbilityByName("invoker_invoke")
					if (ability && ability.IsValid && ability.Level > 0) {
						const isActive = !ability.IsHidden
						if (!isActive) {
							if (invokeAbility && invokeAbility.IsValid && invokeAbility.Cooldown <= 0.1 && hero.Mana >= invokeAbility.ManaCost) {
								if (this.invokeSpell(hero, chosenSpell, invokeAbility)) {
									console.log(`[InvokerCombo] Auto Disrupt: Invoking ${chosenSpell} on ${disruptTarget.Name}`)
									this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
									return
								}
							}
						} else if (ability.Cooldown <= 0.1 && hero.Mana >= ability.ManaCost) {
							if (chosenSpell === "invoker_cold_snap") {
								ExecuteOrder.PrepareOrder({
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
									issuers: [hero],
									target: disruptTarget.Index,
									ability: ability.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								})
							} else {
								ExecuteOrder.PrepareOrder({
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
									issuers: [hero],
									position: disruptTarget.Position,
									ability: ability.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								})
							}
							console.log(`[InvokerCombo] Auto Disrupt: Cast ${chosenSpell} on ${disruptTarget.Name}`)
							this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
							return
						}
					}
				}
			}
		}

		// @ts-ignore
		if (!this.comboKey.isPressed) {
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

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

		const bestTarget = this.lockedTarget
		if (!bestTarget) {
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		if (!isTargetImmune) {
			const blink = hero.Items.find(i => i.Name.startsWith("item_blink"))
			if (blink && this.itemsSelector.IsEnabled("item_blink") && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost) {
				const blinkRange = 1200
				const currentDist = hero.Distance2D(bestTarget)
				if (currentDist > 600 && currentDist <= blinkRange + 200) {
					const blinkPos = bestTarget.Position.Extend(hero.Position, 400)
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: blinkPos,
						ability: blink.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
			}

			if (this.useTargetItem(hero, "item_sheepstick", bestTarget)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}

			if (this.useTargetItem(hero, "item_nullifier", bestTarget)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}

			if (this.useTargetItem(hero, "item_orchid", bestTarget) || this.useTargetItem(hero, "item_bloodthorn", bestTarget)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return
			}

			const tornadoAbility = hero.GetAbilityByName("invoker_tornado")
			const isTornadoReady = tornadoAbility && tornadoAbility.Level > 0 && tornadoAbility.Cooldown <= 0.1
			const hasActiveLiftBuff = bestTarget.Buffs.some(m =>
				m.Name === "modifier_invoker_tornado" ||
				m.Name === "modifier_euler_cyclone" ||
				m.Name === "modifier_wind_waker_active"
			)

			if (!hasActiveLiftBuff && (!isTornadoReady || !this.comboSequenceGrid.IsEnabled("invoker_tornado"))) {
				if (this.useTargetItem(hero, "item_cyclone", bestTarget) || this.useTargetItem(hero, "item_wind_waker", bestTarget)) {
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
			}
		}

		const liftBuff = bestTarget.Buffs.find(m =>
			m.Name === "modifier_invoker_tornado" ||
			m.Name === "modifier_euler_cyclone" ||
			m.Name === "modifier_wind_waker_active"
		)

		const invokeAbility = hero.GetAbilityByName("invoker_invoke")

		for (const spellName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			const ability = hero.GetAbilityByName(spellName)
			if (!ability || !ability.IsValid || ability.Level <= 0) {
				continue
			}

			if (isTargetImmune && spellName !== "invoker_sun_strike") {
				continue
			}

			if (ability.Cooldown > 0.1) {
				continue
			}

			if (hero.Mana < ability.ManaCost) {
				continue
			}

			let castRange = ability.CastRange > 0 ? ability.CastRange : 800
			if (spellName === "invoker_ice_wall") {
				castRange = 520
			}
			if (hero.Distance2D(bestTarget) > castRange) {
				continue
			}

			const active = !ability.IsHidden

			if (!active) {
				if (!invokeAbility || !invokeAbility.IsValid || invokeAbility.Cooldown > 0.1 || hero.Mana < invokeAbility.ManaCost) {
					let foundLaterSpell = false
					for (let i = this.comboSequenceGrid.values.indexOf(spellName) + 1; i < this.comboSequenceGrid.values.length; i++) {
						const laterName = this.comboSequenceGrid.values[i]
						if (!this.comboSequenceGrid.IsEnabled(laterName)) continue
						const laterAbil = hero.GetAbilityByName(laterName)
						if (laterAbil && laterAbil.IsValid && laterAbil.Level > 0 && !laterAbil.IsHidden && laterAbil.Cooldown <= 0.1 && hero.Mana >= laterAbil.ManaCost) {
							if (this.castInvokerSpell(hero, laterAbil, bestTarget, liftBuff)) {
								return
							}
							foundLaterSpell = true
							break
						}
					}
					if (foundLaterSpell) {
						return
					}
					continue
				}

				if (this.invokeSpell(hero, spellName, invokeAbility)) {
					console.log(`[InvokerCombo] Invoked spell: ${spellName}`)
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
				continue
			}

			if (this.castInvokerSpell(hero, ability, bestTarget, liftBuff)) {
				return
			}
		}

		if (!isTargetImmune && hero.Distance2D(bestTarget) <= 900) {
			if (this.useNoTargetItem(hero, "item_shivas_guard")) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
				return
			}
		}

		if (this.itemsSelector.IsEnabled("item_refresher")) {
			const refresher = hero.Items.find(i => i.Name === "item_refresher")
			if (refresher && refresher.IsValid && refresher.Cooldown <= 0.1 && hero.Mana >= refresher.ManaCost) {
				const meteor = hero.GetAbilityByName("invoker_chaos_meteor")
				const sunstrike = hero.GetAbilityByName("invoker_sun_strike")
				const deafening = hero.GetAbilityByName("invoker_deafening_blast")
				
				const meteorOnCd = !meteor || meteor.Level <= 0 || meteor.Cooldown > 2.0
				const sunstrikeOnCd = !sunstrike || sunstrike.Level <= 0 || sunstrike.Cooldown > 2.0
				const deafeningOnCd = !deafening || deafening.Level <= 0 || deafening.Cooldown > 2.0

				if (meteorOnCd && sunstrikeOnCd && deafeningOnCd) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: refresher.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 150)
					return
				}
			}
		}

		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}
})()
