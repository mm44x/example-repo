import {
	Ability,
	Color,
	Creep,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	InputManager,
	Item,
	LocalPlayer,
	Menu,
	ParticleAttachment,
	ParticlesSDK,
	RendererSDK,
	TickSleeper,
	Unit,
	Vector2,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"
import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = ["pudge_meat_hook", "pudge_rot", "pudge_flesh_heap", "pudge_dismember"]

const COMBO_ITEMS = [
	"item_blink",
	"item_blade_mail",
	"item_black_king_bar",
	"item_rod_of_atos",
	"item_gungir",
	"item_urn_of_shadows",
	"item_spirit_vessel",
	"item_ethereal_blade",
	"item_shivas_guard",
	"item_sheepstick",
	"item_orchid",
	"item_bloodthorn",
	"item_nullifier",
	"item_dagon"
]

new (class PudgeCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Pudge Combo", "panorama/images/heroes/icons/npc_dota_hero_pudge_png.vtex_c", "", 0)

	// Combo Controls
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute full Pudge combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 1200, 400, 1600, 0)
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"Locks onto a single target hero when holding the combo key"
	)

	// Skill Order (Combo Sequence)
	private comboSequenceGrid: any

	// Auto Hook Enemy Settings
	private readonly enemyHookNode = this.entry.AddNode("Auto Hook Enemy")
	private readonly standaloneHookKey = this.enemyHookNode.AddKeybind(
		"Instant Smart Hook Key",
		"G",
		"One-tap key to calculate lead prediction and hook the nearest enemy without full combo"
	)
	private readonly hookPredictMovement = this.enemyHookNode.AddToggle(
		"Movement Lead Prediction",
		true,
		"Predict moving enemy position based on distance, hook speed (1600), and latency"
	)
	private readonly checkObstacles = this.enemyHookNode.AddToggle(
		"Check Obstacles (Creep/Hero)",
		true,
		"Avoid hooking if intervening creeps or heroes block the trajectory line"
	)
	private readonly autoHookStunned = this.enemyHookNode.AddToggle(
		"Auto Hook Stunned / Rooted",
		true,
		"Auto hook stunned, rooted, or hexed enemies if the hook will arrive before the disable expires"
	)
	private readonly autoHookChanneling = this.enemyHookNode.AddToggle(
		"Auto Hook Channeling",
		true,
		"Auto hook enemies channeling continuous abilities or Teleport if path is clear"
	)
	private readonly autoHookDrawTarget = this.enemyHookNode.AddToggle(
		"Draw Hook Predicted Indicator",
		true,
		"Draw predicted position circle and trajectory line when targeting"
	)

	// Auto Hook Ally (Save) Settings
	private readonly allyHookNode = this.entry.AddNode("Auto Hook Ally (Save)")
	private readonly hookAllyKey = this.allyHookNode.AddKeybind(
		"Hook Ally Hotkey",
		"None",
		"One-tap key to calculate lead prediction and hook the nearest ally towards Pudge"
	)
	private readonly autoHookStunnedAllies = this.allyHookNode.AddToggle(
		"Auto Hook Stunned / Rooted Allies",
		true,
		"Auto hook disabled or stunned teammates to pull them to safety if path is clear"
	)
	private readonly allyCheckObstacles = this.allyHookNode.AddToggle(
		"Check Obstacles for Ally Hook",
		true,
		"Avoid hooking ally if intervening creeps or heroes block the trajectory line"
	)

	// Rot Settings
	private readonly rotNode = this.entry.AddNode("Rot Management")
	private readonly autoRotNearEnemy = this.rotNode.AddToggle(
		"Auto Rot (Burn & Turn Off)",
		true,
		"Auto toggle ON when in Rot radius, auto toggle OFF when enemy leaves or dies"
	)
	private readonly rotMinHpPct = this.rotNode.AddSlider(
		"Rot Min HP %",
		10,
		1,
		50,
		0,
		"Turn OFF Rot if Pudge HP falls below this threshold to prevent accidental self-damage"
	)

	// Dismember Settings
	private readonly dismemberNode = this.entry.AddNode("Dismember (Ultimate)")
	private readonly protectDismemberChannel = this.dismemberNode.AddToggle(
		"Strict Channel Protection",
		true,
		"Prevent any orders or movement while Pudge is actively channeling Dismember"
	)

	// Items Integration
	private readonly itemsNode = this.entry.AddNode("Items Integration")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Use Items",
		COMBO_ITEMS,
		new Map([
			["item_blink", true],
			["item_blade_mail", true],
			["item_black_king_bar", true],
			["item_rod_of_atos", true],
			["item_urn_of_shadows", true],
			["item_spirit_vessel", true],
			["item_ethereal_blade", true],
			["item_shivas_guard", true],
			["item_sheepstick", true],
			["item_orchid", true],
			["item_bloodthorn", true],
			["item_nullifier", true],
			["item_dagon", true]
		]),
		"Enable or disable items for Pudge combo"
	)

	private readonly blinkMode = this.itemsNode.AddDropdown(
		"Blink Dagger Usage",
		["Blink Directly to Target", "Blink Max Range Towards Target", "Disabled"],
		0,
		"How Blink Dagger initiates on the target"
	)

	// Smart Orb Walk
	private readonly smartOrbWalkEnabled = this.entry.AddToggle(
		"Enable Smart Orb Walk",
		true,
		"Follow moving targets by cancelling attack backswing during cooldowns"
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

	private readonly sleeper = new TickSleeper()
	private readonly autoHookSleeper = new TickSleeper()
	private readonly rotSleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	private lockedTarget: Hero | undefined = undefined
	private lastPredictedHookPos: Vector3 | undefined = undefined
	private pendingAtosTarget: Hero | undefined = undefined
	private pendingAtosTime = 0
	private hookInFlightUntil = 0

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("pudge_meat_hook", [true, true, true, 0])
		defaultCombo.set("pudge_rot", [true, true, true, 1])
		defaultCombo.set("pudge_flesh_heap", [true, true, true, 2])
		defaultCombo.set("pudge_dismember", [true, true, true, 3])

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

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.autoHookSleeper.Sleep(0)
		this.rotSleeper.Sleep(0)
		this.lockedTarget = undefined
		this.lastPredictedHookPos = undefined
		this.pendingAtosTarget = undefined
		this.pendingAtosTime = 0
		this.hookInFlightUntil = 0
		this.pSDK.DestroyAll()

		if (this.comboSequenceGrid) {
			this.comboSequenceGrid.ResetToDefault()
		}
	}

	private get hasLocalHero(): boolean {
		return Boolean(
			LocalPlayer &&
				LocalPlayer.Hero &&
				LocalPlayer.Hero.IsValid &&
				LocalPlayer.Hero.Name === "npc_dota_hero_pudge"
		)
	}

	private getItem(hero: Hero, baseName: string): Item | undefined {
		for (const item of hero.Items) {
			if (item && item.IsValid && item.Name.startsWith(baseName)) {
				return item
			}
		}
		return undefined
	}

	/**
	 * Calculates the remaining time of stun, root, hex, or sleep on a unit.
	 */
	/**
	 * Calculates the remaining time of stun, root, hex, or sleep on a unit.
	 */
	private getStunOrRootRemaining(target: Hero): number {
		let maxRemaining = 0
		if (target.IsStunned || target.IsRooted || target.IsHexed) {
			for (const buff of target.Buffs) {
				if (buff.IsValid && buff.RemainingTime > 0) {
					const name = buff.Name.toLowerCase()
					if (
						name.includes("stun") ||
						name.includes("root") ||
						name.includes("bashed") ||
						name.includes("shackles") ||
						name.includes("fiends_grip") ||
						name.includes("black_hole") ||
						name.includes("hex") ||
						name.includes("sheepstick") ||
						name.includes("cyclone") ||
						name.includes("eul") ||
						name.includes("atos") ||
						name.includes("gleipnir") ||
						name.includes("frostbite") ||
						name.includes("entangle") ||
						name.includes("hold") ||
						name.includes("sleep")
					) {
						if (buff.RemainingTime > maxRemaining) {
							maxRemaining = buff.RemainingTime
						}
					}
				}
			}
			if (maxRemaining === 0) {
				for (const buff of target.Buffs) {
					if (buff.IsValid && buff.RemainingTime > maxRemaining) {
						maxRemaining = buff.RemainingTime
					}
				}
			}
		}
		return maxRemaining
	}

	/**
	 * Calculates true mathematical intercept lead position for Meat Hook, taking into account:
	 * - Pudge turn time towards predicted target
	 * - Cast point (0.3s) & network ping / tick latency
	 * - Projectile flight time (1600 speed)
	 * - True linear velocity vector (target.Forward * target.MoveSpeed)
	 * - Disables, Channeling, and Rod of Atos impact sync
	 */
	private calculateHookLead(hero: Hero, target: Hero, hookAbil: Ability): Vector3 {
		const hookSpeed = 1600
		const castPoint = hookAbil.CastPoint > 0 ? hookAbil.CastPoint : 0.3
		const latency = (GameState.InputLag || 0.03) + 0.033

		// 1. If target is stationary (stunned, rooted, hexed, sleep, channeling, or not moving), hook directly at position
		if (
			target.IsStunned ||
			target.IsRooted ||
			target.IsHexed ||
			target.IsChanneling ||
			!this.hookPredictMovement.value ||
			!target.IsMoving
		) {
			return target.Position.Clone()
		}

		const targetSpeed = target.MoveSpeed > 0 ? target.MoveSpeed : 300
		const forward = target.Forward

		// 2. If Rod of Atos was fired at this target, predict where Atos will hit and root them
		if (this.pendingAtosTarget === target && GameState.RawGameTime <= this.pendingAtosTime) {
			const remainingAtosFlight = Math.max(0, this.pendingAtosTime - GameState.RawGameTime)
			return target.Position.Add(forward.MultiplyScalar(targetSpeed * remainingAtosFlight))
		}

		// 3. Iterative solver: calculate turn time + cast point + flight time + latency using true target velocity
		let predPos = target.Position.Clone()

		for (let iter = 0; iter < 5; iter++) {
			const turnTime = hero.GetTurnTime(predPos)
			const dist = hero.Distance2D(predPos)
			const flightTime = dist / hookSpeed
			const totalDelay = turnTime + castPoint + flightTime + latency

			predPos = target.Position.Add(forward.MultiplyScalar(targetSpeed * totalDelay))
		}

		return predPos
	}

	/**
	 * Checks whether the line segment from Pudge to predicted target is blocked by any creep, neutral, or other hero.
	 */
	private isHookPathClear(hero: Hero, target: Hero, targetPos: Vector3, hookRadius = 100): boolean {
		const isAlly = !target.IsEnemy(hero)
		if (isAlly) {
			if (!this.allyCheckObstacles.value) {
				return true
			}
		} else if (!this.checkObstacles.value) {
			return true
		}

		const p1 = hero.Position
		const p2 = targetPos

		const lineVec = p2.Subtract(p1)
		const lineLenSq = lineVec.x * lineVec.x + lineVec.y * lineVec.y
		if (lineLenSq === 0) {
			return true
		}
		const lineLen = Math.sqrt(lineLenSq)
		const latency = (GameState.InputLag || 0.03) + 0.033
		const turnTime = hero.GetTurnTime(p2)

		// Check all potential obstacle units (creeps, lane creeps, neutrals, other heroes, summons)
		const potentialObstacles: Unit[] = [
			...EntityManager.GetEntitiesByClass(Creep),
			...EntityManager.GetEntitiesByClass(Hero),
			...EntityManager.GetEntitiesByClass(Unit)
		]

		for (const unit of potentialObstacles) {
			if (
				!unit ||
				!unit.IsValid ||
				!unit.IsAlive ||
				unit.IsInvulnerable ||
				unit.IsCourier ||
				unit === hero ||
				unit.Index === hero.Index ||
				unit === target ||
				unit.Index === target.Index
			) {
				continue
			}

			// Exclude non-blocking building entities
			if (unit.IsBuilding || unit.IsTower) {
				continue
			}

			const unitRadius = unit.HullRadius > 0 ? unit.HullRadius : 24
			// In Dota 2, Meat Hook hitbox radius is 100. Effective collision is hookRadius + unitRadius + buffer.
			const requiredClearance = hookRadius + unitRadius + 15

			// 1. Current position obstacle check
			const uPos = unit.Position
			const toUnit = uPos.Subtract(p1)

			const t = (toUnit.x * lineVec.x + toUnit.y * lineVec.y) / lineLenSq

			// Check if obstacle is along the path between Pudge and target
			if (t >= -0.05 && t <= 1.05) {
				const clampedT = Math.max(0, Math.min(1, t))
				const proj = p1.Add(lineVec.MultiplyScalar(clampedT))
				const dist = proj.Distance2D(uPos)

				if (dist < requiredClearance) {
					return false // Path is blocked by this unit
				}
			}

			// 2. Moving unit predicted intercept check
			if (unit.IsMoving) {
				const clampedT = Math.max(0, Math.min(1, t))
				const distAlongHook = clampedT * lineLen
				const hookArrivalTime = turnTime + 0.3 + distAlongHook / 1600 + latency
				const uSpeed = unit.MoveSpeed > 0 ? unit.MoveSpeed : 300
				const predPos = unit.Position.Add(unit.Forward.MultiplyScalar(uSpeed * hookArrivalTime))
				const toPredUnit = predPos.Subtract(p1)

				const tPred = (toPredUnit.x * lineVec.x + toPredUnit.y * lineVec.y) / lineLenSq

				if (tPred >= -0.05 && tPred <= 1.05) {
					const clampedTPred = Math.max(0, Math.min(1, tPred))
					const projPred = p1.Add(lineVec.MultiplyScalar(clampedTPred))
					const distPred = projPred.Distance2D(predPos)

					if (distPred < requiredClearance) {
						return false // Moving unit will intercept the hook
					}
				}
			}
		}

		return true
	}

	/**
	 * Auto Rot Controller: burns nearby enemies, turns off when no enemies are around or HP is critically low.
	 */
	private handleAutoRot(hero: Hero): void {
		if (!this.autoRotNearEnemy.value || this.rotSleeper.Sleeping) {
			return
		}

		const rot = hero.GetAbilityByName("pudge_rot")
		if (!rot || !rot.IsValid || rot.Level <= 0) {
			return
		}

		const isRotActive = rot.IsToggled || hero.HasBuffByName("modifier_pudge_rot")
		const hpPct = (hero.HP / hero.MaxHP) * 100

		// Safety check: turn off Rot if HP is dangerously low
		if (hpPct <= this.rotMinHpPct.value) {
			if (isRotActive) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE,
					issuers: [hero],
					ability: rot.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.rotSleeper.Sleep(150)
			}
			return
		}

		// Calculate Rot radius (450 with Scepter, 250 base)
		const rotRadius = hero.HasScepter ? 450 : 250
		let enemyNear = false

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
				if (hero.Distance2D(enemy) <= rotRadius + 50) {
					enemyNear = true
					break
				}
			}
		}

		if (enemyNear && !isRotActive) {
			claimOrder()
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE,
				issuers: [hero],
				ability: rot.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			this.rotSleeper.Sleep(150)
		} else if (!enemyNear && isRotActive && !hero.IsChanneling) {
			claimOrder()
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE,
				issuers: [hero],
				ability: rot.Index,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			this.rotSleeper.Sleep(150)
		}
	}

	/**
	 * Background Auto Hook for Stunned / Rooted / Channeling enemies & disabled allies.
	 */
	private handleAutoHookBackground(hero: Hero): boolean {
		if (this.autoHookSleeper.Sleeping || this.sleeper.Sleeping) {
			return false
		}

		const hookAbil = hero.GetAbilityByName("pudge_meat_hook")
		if (
			!hookAbil ||
			!hookAbil.IsValid ||
			hookAbil.Level <= 0 ||
			hookAbil.Cooldown > 0.1 ||
			hero.Mana < hookAbil.ManaCost
		) {
			return false
		}

		const castRange = hookAbil.CastRange > 0 ? hookAbil.CastRange : 1300
		const hookSpeed = 1600
		const castPoint = hookAbil.CastPoint > 0 ? hookAbil.CastPoint : 0.3
		const latency = (GameState.InputLag || 0.03) + 0.033

		// 1. Auto Hook Disabled / Stunned Teammates (Save)
		if (this.autoHookStunnedAllies.value) {
			for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
				if (
					!ally.IsValid ||
					!ally.IsAlive ||
					ally.IsEnemy(hero) ||
					ally.IsIllusion ||
					ally === hero ||
					ally.Index === hero.Index
				) {
					continue
				}

				const dist = hero.Distance2D(ally)
				if (dist > castRange) {
					continue
				}

				const turnTime = hero.GetTurnTime(ally.Position)
				const flightTime = dist / hookSpeed
				const totalArrivalTime = turnTime + castPoint + flightTime + latency
				const disableRemaining = this.getStunOrRootRemaining(ally)

				if (disableRemaining >= totalArrivalTime + 0.05 && disableRemaining > 0.1) {
					const targetPos = ally.Position.Clone()
					if (this.isHookPathClear(hero, ally, targetPos)) {
						this.hookInFlightUntil = GameState.RawGameTime + dist / hookSpeed + 0.6
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: targetPos,
							ability: hookAbil.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.autoHookSleeper.Sleep(castPoint * 1000 + 400)
						return true
					}
				}
			}
		}

		// 2. Auto Hook Stunned / Rooted / Channeling Enemies
		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (!enemy.IsValid || !enemy.IsAlive || !enemy.IsEnemy(hero) || enemy.IsIllusion) {
				continue
			}

			const dist = hero.Distance2D(enemy)
			if (dist > castRange) {
				continue
			}

			const turnTime = hero.GetTurnTime(enemy.Position)
			const flightTime = dist / hookSpeed
			const totalArrivalTime = turnTime + castPoint + flightTime + latency

			// Check Auto Hook Stunned / Rooted / Hexed
			if (this.autoHookStunned.value) {
				const disableRemaining = this.getStunOrRootRemaining(enemy)
				if (disableRemaining >= totalArrivalTime + 0.05 && disableRemaining > 0.1) {
					const targetPos = enemy.Position.Clone()
					if (this.isHookPathClear(hero, enemy, targetPos)) {
						this.hookInFlightUntil = GameState.RawGameTime + dist / hookSpeed + 0.6
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: targetPos,
							ability: hookAbil.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.autoHookSleeper.Sleep(castPoint * 1000 + 400)
						return true
					}
				}
			}

			// Check Auto Hook Channeling
			if (this.autoHookChanneling.value && enemy.IsChanneling) {
				const targetPos = enemy.Position.Clone()
				if (this.isHookPathClear(hero, enemy, targetPos)) {
					this.hookInFlightUntil = GameState.RawGameTime + dist / hookSpeed + 0.6
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: targetPos,
						ability: hookAbil.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.autoHookSleeper.Sleep(castPoint * 1000 + 400)
					return true
				}
			}
		}

		return false
	}

	/**
	 * Executes offensive and defensive items during combo.
	 */
	private executeItems(hero: Hero, bestTarget: Hero, isTargetImmune: boolean): boolean {
		// 1. BLINK DAGGER
		if (this.itemsSelector.IsEnabled("item_blink") && this.blinkMode.SelectedID !== 2) {
			const isHookActiveOrPulling =
				hero.HasBuffByName("modifier_pudge_meat_hook_followthrough") ||
				bestTarget.HasBuffByName("modifier_pudge_meat_hook") ||
				GameState.RawGameTime < this.hookInFlightUntil

			// Strictly do NOT blink if hook is currently flying or target is being pulled to Pudge
			if (!isHookActiveOrPulling) {
				const hook = hero.GetAbilityByName("pudge_meat_hook")
				const isHookPrimaryAndReady =
					this.comboSequenceGrid &&
					this.comboSequenceGrid.IsEnabled("pudge_meat_hook") &&
					hook &&
					hook.IsValid &&
					hook.Level > 0 &&
					hook.Cooldown <= 0.1 &&
					hero.Mana >= hook.ManaCost &&
					hero.Distance2D(bestTarget) <= (hook.CastRange > 0 ? hook.CastRange : 1300) &&
					this.isHookPathClear(hero, bestTarget, this.calculateHookLead(hero, bestTarget, hook))

				// If Hook is available and clear to pull target, don't waste Blink; let Hook pull them in!
				// Only blink if Hook is on cooldown, path is blocked, or target is out of hook range
				if (!isHookPrimaryAndReady) {
					const blink =
						this.getItem(hero, "item_blink") ||
						this.getItem(hero, "item_arcane_blink") ||
						this.getItem(hero, "item_swift_blink") ||
						this.getItem(hero, "item_overwhelming_blink")

					if (blink && blink.Cooldown <= 0.1) {
						const dist = hero.Distance2D(bestTarget)
						if (dist > 400 && dist <= 1200) {
							let blinkPos = bestTarget.Position.Clone()
							if (this.blinkMode.SelectedID === 1) {
								const dir = bestTarget.Position.Subtract(hero.Position).Normalize()
								blinkPos = hero.Position.Add(dir.MultiplyScalar(1150))
							}

							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: blinkPos,
								ability: blink.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
							return true
						}
					}
				}
			}
		}

		// 2. BLACK KING BAR (BKB)
		if (this.itemsSelector.IsEnabled("item_black_king_bar")) {
			const bkb = this.getItem(hero, "item_black_king_bar")
			if (bkb && bkb.Cooldown <= 0.1 && hero.Distance2D(bestTarget) <= 700) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: bkb.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 3. BLADE MAIL
		if (this.itemsSelector.IsEnabled("item_blade_mail")) {
			const bm = this.getItem(hero, "item_blade_mail")
			if (bm && bm.Cooldown <= 0.1 && hero.Mana >= bm.ManaCost && hero.Distance2D(bestTarget) <= 600) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: bm.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 4. SCYTHE OF VYSE (HEX)
		if (this.itemsSelector.IsEnabled("item_sheepstick") && !isTargetImmune) {
			const hex = this.getItem(hero, "item_sheepstick")
			if (hex && hex.Cooldown <= 0.1 && hero.Mana >= hex.ManaCost && hero.Distance2D(bestTarget) <= 800) {
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
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 5. ROD OF ATOS / GLEIPNIR (Integrated with Meat Hook timing)
		if (
			(this.itemsSelector.IsEnabled("item_rod_of_atos") || this.itemsSelector.IsEnabled("item_gungir")) &&
			!isTargetImmune
		) {
			const atos = this.getItem(hero, "item_gungir") || this.getItem(hero, "item_rod_of_atos")
			if (
				atos &&
				atos.Cooldown <= 0.1 &&
				hero.Mana >= atos.ManaCost &&
				hero.Distance2D(bestTarget) <= 1100 &&
				!bestTarget.IsRooted &&
				!bestTarget.IsStunned
			) {
				const dist = hero.Distance2D(bestTarget)
				const atosProjSpeed = atos.Name === "item_gungir" ? 1900 : 1600
				const atosFlightTime = dist / atosProjSpeed

				this.pendingAtosTarget = bestTarget
				this.pendingAtosTime = GameState.RawGameTime + atosFlightTime

				claimOrder()
				if (atos.Name === "item_gungir") {
					const castPos = bestTarget.Position.Clone()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: castPos,
						ability: atos.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				} else {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: atos.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
				}
				this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
				return true
			}
		}

		// 6. ORCHID / BLOODTHORN
		if (
			(this.itemsSelector.IsEnabled("item_orchid") || this.itemsSelector.IsEnabled("item_bloodthorn")) &&
			!isTargetImmune
		) {
			const silence = this.getItem(hero, "item_bloodthorn") || this.getItem(hero, "item_orchid")
			if (
				silence &&
				silence.Cooldown <= 0.1 &&
				hero.Mana >= silence.ManaCost &&
				hero.Distance2D(bestTarget) <= 900
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: silence.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 7. NULLIFIER
		if (this.itemsSelector.IsEnabled("item_nullifier") && !isTargetImmune) {
			const nullifier = this.getItem(hero, "item_nullifier")
			if (
				nullifier &&
				nullifier.Cooldown <= 0.1 &&
				hero.Mana >= nullifier.ManaCost &&
				hero.Distance2D(bestTarget) <= 900
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: nullifier.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 8. ETHEREAL BLADE
		if (this.itemsSelector.IsEnabled("item_ethereal_blade") && !isTargetImmune) {
			const eblade = this.getItem(hero, "item_ethereal_blade")
			if (
				eblade &&
				eblade.Cooldown <= 0.1 &&
				hero.Mana >= eblade.ManaCost &&
				hero.Distance2D(bestTarget) <= 800
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: eblade.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 9. URN OF SHADOWS / SPIRIT VESSEL
		if (
			(this.itemsSelector.IsEnabled("item_urn_of_shadows") ||
				this.itemsSelector.IsEnabled("item_spirit_vessel")) &&
			!isTargetImmune
		) {
			const vessel = this.getItem(hero, "item_spirit_vessel") || this.getItem(hero, "item_urn_of_shadows")
			if (
				vessel &&
				vessel.Cooldown <= 0.1 &&
				vessel.CurrentCharges > 0 &&
				hero.Distance2D(bestTarget) <= 950 &&
				!bestTarget.HasBuffByName("modifier_item_spirit_vessel_damage") &&
				!bestTarget.HasBuffByName("modifier_item_urn_damage")
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: vessel.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 10. SHIVA'S GUARD
		if (this.itemsSelector.IsEnabled("item_shivas_guard") && !isTargetImmune) {
			const shiva = this.getItem(hero, "item_shivas_guard")
			if (shiva && shiva.Cooldown <= 0.1 && hero.Mana >= shiva.ManaCost && hero.Distance2D(bestTarget) <= 900) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: shiva.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 11. DAGON
		if (this.itemsSelector.IsEnabled("item_dagon") && !isTargetImmune) {
			const dagon = this.getItem(hero, "item_dagon")
			if (dagon && dagon.Cooldown <= 0.1 && hero.Mana >= dagon.ManaCost && hero.Distance2D(bestTarget) <= 800) {
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
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		return false
	}

	private OnDraw(): void {
		// Keep Combo Order always synchronized with all 4 abilities even in main menu or hero pick screen
		if (this.comboSequenceGrid) {
			let dirty = false
			for (const spell of COMBO_SPELLS) {
				if (!this.comboSequenceGrid.enabledValues.has(spell)) {
					this.comboSequenceGrid.enabledValues.set(spell, [
						true,
						true,
						true,
						this.comboSequenceGrid.enabledValues.size
					])
					dirty = true
				}
				if (!this.comboSequenceGrid.values.includes(spell)) {
					this.comboSequenceGrid.values.push(spell)
					dirty = true
				}
			}
			if (dirty) {
				this.comboSequenceGrid.Update()
			}
		}

		if (!this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Draw predicted hook path indicator if enabled
		if (this.autoHookDrawTarget.value && this.lastPredictedHookPos) {
			const targetScreenPos = RendererSDK.WorldToScreen(this.lastPredictedHookPos)
			if (targetScreenPos) {
				const circleSize = new Vector2(50, 50)
				RendererSDK.OutlinedCircle(targetScreenPos.Subtract(new Vector2(25, 25)), circleSize, Color.Red, 2)
			}
			const pudgeScreenPos = RendererSDK.WorldToScreen(hero.Position)
			if (pudgeScreenPos && targetScreenPos) {
				RendererSDK.Line(pudgeScreenPos, targetScreenPos, Color.Red.SetA(150), 2)
			}
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.lockedTarget = undefined
			this.lastPredictedHookPos = undefined
			this.pSDK.DestroyByKey("pudge_target_ring")
			return
		}

		// Synchronize any missing COMBO_SPELLS from old configs into comboSequenceGrid
		if (this.comboSequenceGrid) {
			let dirty = false
			for (const spell of COMBO_SPELLS) {
				if (!this.comboSequenceGrid.enabledValues.has(spell)) {
					this.comboSequenceGrid.enabledValues.set(spell, [
						true,
						true,
						true,
						this.comboSequenceGrid.enabledValues.size
					])
					dirty = true
				}
				if (!this.comboSequenceGrid.values.includes(spell)) {
					this.comboSequenceGrid.values.push(spell)
					dirty = true
				}
			}
			if (dirty) {
				this.comboSequenceGrid.Update()
				Menu.Base.SaveConfigASAP = true
			}
		}

		// 1. Handle Auto Rot Background Toggle (Instant 0-cast-point toggle, never breaks channeling)
		this.handleAutoRot(hero)

		// 2. Channel Protection: Strictly halt any movement/spell/attack actions while channeling Dismember
		if (hero.IsChanneling) {
			if (this.protectDismemberChannel.value) {
				return
			}
		}

		// 3. Handle Auto Hook Background (Stunned / Channeling)
		if (!hero.IsChanneling && !hero.IsStunned && !hero.IsSilenced && !hero.IsHexed) {
			if (this.handleAutoHookBackground(hero)) {
				return
			}
		}

		// 4. Standalone Instant Smart Hook Enemy Key
		// @ts-ignore
		if (this.standaloneHookKey.isPressed) {
			const instantHook = hero.GetAbilityByName("pudge_meat_hook")
			if (
				instantHook &&
				instantHook.IsValid &&
				instantHook.Level > 0 &&
				instantHook.Cooldown <= 0.1 &&
				hero.Mana >= instantHook.ManaCost
			) {
				const mousePos = InputManager.CursorOnWorld
				let nearestEnemy: Hero | undefined
				let minDist = Infinity
				const castRange = instantHook.CastRange > 0 ? instantHook.CastRange : 1300

				for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
					if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
						const distToMouse = enemy.Position.Distance2D(mousePos)
						const distToPudge = hero.Distance2D(enemy)
						if (distToPudge <= castRange + 150 && distToMouse < minDist) {
							minDist = distToMouse
							nearestEnemy = enemy
						}
					}
				}

				if (nearestEnemy) {
					const predictedPos = this.calculateHookLead(hero, nearestEnemy, instantHook)
					this.lastPredictedHookPos = predictedPos

					if (this.isHookPathClear(hero, nearestEnemy, predictedPos)) {
						this.hookInFlightUntil = GameState.RawGameTime + hero.Distance2D(nearestEnemy) / 1600 + 0.6
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: predictedPos,
							ability: instantHook.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(instantHook.CastPoint * 1000 + 400)
						return
					}
				}
			}
		}

		// 5. Standalone Hook Ally Key (Save)
		// @ts-ignore
		if (this.hookAllyKey.isPressed) {
			const hookAbil = hero.GetAbilityByName("pudge_meat_hook")
			if (
				hookAbil &&
				hookAbil.IsValid &&
				hookAbil.Level > 0 &&
				hookAbil.Cooldown <= 0.1 &&
				hero.Mana >= hookAbil.ManaCost
			) {
				const mousePos = InputManager.CursorOnWorld
				let nearestAlly: Hero | undefined
				let minDist = Infinity
				const castRange = hookAbil.CastRange > 0 ? hookAbil.CastRange : 1300

				for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
					if (
						ally.IsValid &&
						ally.IsAlive &&
						ally.IsVisible &&
						!ally.IsEnemy(hero) &&
						!ally.IsIllusion &&
						ally !== hero
					) {
						const distToMouse = ally.Position.Distance2D(mousePos)
						const distToPudge = hero.Distance2D(ally)
						if (distToPudge <= castRange + 150 && distToMouse < minDist) {
							minDist = distToMouse
							nearestAlly = ally
						}
					}
				}

				if (nearestAlly) {
					const predictedPos = this.calculateHookLead(hero, nearestAlly, hookAbil)
					this.lastPredictedHookPos = predictedPos

					if (this.isHookPathClear(hero, nearestAlly, predictedPos)) {
						this.hookInFlightUntil = GameState.RawGameTime + hero.Distance2D(nearestAlly) / 1600 + 0.6
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: predictedPos,
							ability: hookAbil.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(hookAbil.CastPoint * 1000 + 400)
						return
					}
				}
			}
		}

		// 6. Check if Combo Key is held
		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			this.lastPredictedHookPos = undefined
			this.pendingAtosTarget = undefined
			this.pSDK.DestroyByKey("pudge_target_ring")
			return
		}

		if (hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// ------------------ TARGET SELECTION & LOCKING ------------------
		let bestTarget: Hero | undefined = this.lockedTarget
		if (!bestTarget || !bestTarget.IsValid || !bestTarget.IsAlive || !bestTarget.IsVisible) {
			const mousePos = InputManager.CursorOnWorld
			let minDist = Infinity
			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
					const dist = enemy.Position.Distance2D(mousePos)
					if (dist < this.comboRadius.value && dist < minDist) {
						minDist = dist
						bestTarget = enemy
					}
				}
			}
			if (this.lockTargetEnabled.value && bestTarget) {
				this.lockedTarget = bestTarget
			}
		}

		if (!bestTarget) {
			this.pSDK.DestroyByKey("pudge_target_ring")
			this.lastPredictedHookPos = undefined
			return
		}

		this.pSDK.DrawCircle("pudge_target_ring", bestTarget, 140, {
			Color: new Color(255, 80, 0, 220),
			Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
		})

		if (this.sleeper.Sleeping) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// ------------------ ITEMS EXECUTION ------------------
		if (this.executeItems(hero, bestTarget, isTargetImmune)) {
			return
		}

		// ------------------ SKILL ORDER ROTATION ------------------
		if (this.comboSequenceGrid) {
			for (const actionName of this.comboSequenceGrid.values) {
				if (!this.comboSequenceGrid.IsEnabled(actionName)) {
					continue
				}

				// 1. MEAT HOOK
				if (actionName === "pudge_meat_hook") {
					const hook = hero.GetAbilityByName("pudge_meat_hook")
					if (hook && hook.IsValid && hook.Level > 0 && hook.Cooldown <= 0.1 && hero.Mana >= hook.ManaCost) {
						const castRange = hook.CastRange > 0 ? hook.CastRange : 1300
						const dist = hero.Distance2D(bestTarget)

						// Cast hook if outside melee range (> 250) or if target is rooted/stunned
						if (dist <= castRange && (dist > 250 || bestTarget.IsRooted || bestTarget.IsStunned)) {
							const predictedPos = this.calculateHookLead(hero, bestTarget, hook)
							this.lastPredictedHookPos = predictedPos

							if (this.isHookPathClear(hero, bestTarget, predictedPos)) {
								this.hookInFlightUntil = GameState.RawGameTime + dist / 1600 + 0.6
								claimOrder()
								ExecuteOrder.PrepareOrder({
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
									issuers: [hero],
									position: predictedPos,
									ability: hook.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								})
								this.sleeper.Sleep(GameState.InputLag * 1000 + hook.CastPoint * 1000 + 300)
								return
							}
						}
					}
				}

				// 2. ROT (TOGGLE ON IN BURNING RADIUS)
				else if (actionName === "pudge_rot") {
					const rot = hero.GetAbilityByName("pudge_rot")
					if (rot && rot.IsValid && rot.Level > 0) {
						const isRotActive = rot.IsToggled || hero.HasBuffByName("modifier_pudge_rot")
						const rotRadius = hero.HasScepter ? 450 : 250
						const hpPct = (hero.HP / hero.MaxHP) * 100

						if (
							!isRotActive &&
							hero.Distance2D(bestTarget) <= rotRadius + 50 &&
							hpPct > this.rotMinHpPct.value
						) {
							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE,
								issuers: [hero],
								ability: rot.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
							return
						}
					}
				}

				// 3. FLESH HEAP (MEAT SHIELD)
				else if (actionName === "pudge_flesh_heap") {
					const fleshHeap = hero.GetAbilityByName("pudge_flesh_heap")
					if (
						fleshHeap &&
						fleshHeap.IsValid &&
						fleshHeap.Level > 0 &&
						fleshHeap.Cooldown <= 0.1 &&
						hero.Mana >= fleshHeap.ManaCost &&
						hero.Distance2D(bestTarget) <= 600
					) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
							issuers: [hero],
							ability: fleshHeap.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
						return
					}
				}

				// 4. DISMEMBER (ULTIMATE IN MELEE RANGE)
				else if (actionName === "pudge_dismember") {
					const dismember = hero.GetAbilityByName("pudge_dismember")
					if (
						dismember &&
						dismember.IsValid &&
						dismember.Level > 0 &&
						dismember.Cooldown <= 0.1 &&
						hero.Mana >= dismember.ManaCost &&
						!isTargetImmune
					) {
						const castRange = dismember.CastRange > 0 ? dismember.CastRange : 160
						if (hero.Distance2D(bestTarget) <= castRange + 100) {
							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: dismember.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + dismember.CastPoint * 1000 + 200)
							return
						}
					}
				}
			}
		}

		// ------------------ ORB WALK / MELEE ATTACKS ------------------
		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}
})()
