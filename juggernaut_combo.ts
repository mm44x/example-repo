import {
	Color,
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

const COMBO_SPELLS = [
	"juggernaut_omni_slash",
	"juggernaut_swift_slash",
	"juggernaut_blade_fury",
	"juggernaut_healing_ward"
]

const COMBO_ITEMS = [
	"item_blink",
	"item_swift_blink",
	"item_arcane_blink",
	"item_overwhelming_blink",
	"item_phase_boots",
	"item_abyssal_blade",
	"item_diffusal_blade",
	"item_disperser",
	"item_manta",
	"item_nullifier",
	"item_bloodthorn",
	"item_orchid",
	"item_mjollnir",
	"item_black_king_bar",
	"item_satanic"
]

new (class JuggernautCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Juggernaut Combo", "panorama/images/heroes/icons/npc_dota_hero_juggernaut_png.vtex_c", "", 0)

	// Combo Controls
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute full Juggernaut combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 1000, 400, 1500, 0)
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"Locks onto a single target hero when holding the combo key"
	)

	// Skill Order (Combo Sequence)
	private comboSequenceGrid: any

	// Blade Fury & Body Block Settings
	private readonly bladeFuryNode = this.entry.AddNode("Blade Fury & Body Block")
	private readonly bodyBlockEnabled = this.bladeFuryNode.AddToggle(
		"Predictive Body Block",
		true,
		"Position Juggernaut ahead of the enemy movement vector to physically block their retreat path"
	)
	private readonly bodyBlockLeadDist = this.bladeFuryNode.AddSlider(
		"Body Block Lead Distance",
		55,
		35,
		100,
		5,
		"Distance ahead of target center to stand when body blocking (Hero collision hull contact is ~48)"
	)
	private readonly autoPhaseInBladeFury = this.bladeFuryNode.AddToggle(
		"Auto Phase Boots / Disperser",
		true,
		"Automatically activate Phase Boots or Disperser during Blade Fury for phased movement & max speed"
	)
	private readonly drawBladeFuryRadius = this.bladeFuryNode.AddToggle(
		"Draw Blade Fury Radius",
		true,
		"Draw 260 radius ring around Juggernaut during Blade Fury"
	)
	private readonly drawBodyBlockPos = this.bladeFuryNode.AddToggle(
		"Draw Body Block Marker",
		true,
		"Draw a visual marker at the predicted cutoff/body block location"
	)

	// Healing Ward Settings
	private readonly wardNode = this.entry.AddNode("Healing Ward")
	private readonly wardAutoFollow = this.wardNode.AddToggle(
		"Ward Auto Follow Juggernaut",
		true,
		"Automatically orders Healing Ward to follow Juggernaut so it stays safe and heals continuously"
	)

	// Items Integration
	private readonly itemsNode = this.entry.AddNode("Items Integration")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Use Items",
		COMBO_ITEMS,
		new Map([
			["item_blink", true],
			["item_swift_blink", true],
			["item_arcane_blink", true],
			["item_overwhelming_blink", true],
			["item_phase_boots", true],
			["item_abyssal_blade", true],
			["item_diffusal_blade", true],
			["item_disperser", true],
			["item_manta", true],
			["item_nullifier", true],
			["item_bloodthorn", true],
			["item_orchid", true],
			["item_mjollnir", true],
			["item_black_king_bar", true],
			["item_satanic", true]
		]),
		"Enable or disable items for Juggernaut combo"
	)

	private readonly blinkMode = this.itemsNode.AddDropdown(
		"Blink Dagger Usage",
		["Blink Directly to Target", "Blink Max Range Towards Target", "Disabled"],
		0,
		"How Blink Dagger initiates onto the target"
	)

	// Smart Orb Walk
	private readonly smartOrbWalkEnabled = this.entry.AddToggle(
		"Enable Smart Orb Walk",
		true,
		"Follow moving targets and cancel attack backswing outside Blade Fury / Omnislash"
	)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider(
		"Orb Walk Safe Distance %",
		80,
		10,
		100,
		0,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)

	private readonly sleeper = new TickSleeper()
	private readonly wardSleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	private lockedTarget: Hero | undefined = undefined
	private lastBladeFuryMovePos: Vector3 | undefined = undefined
	private lastBladeFuryMoveTime = 0
	private currentBlockTargetPos: Vector3 | undefined = undefined

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("juggernaut_omni_slash", [true, true, true, 0])
		defaultCombo.set("juggernaut_swift_slash", [true, true, true, 1])
		defaultCombo.set("juggernaut_blade_fury", [true, true, true, 2])
		// Healing Ward default disabled in combo, user enables manually if desired
		defaultCombo.set("juggernaut_healing_ward", [false, false, false, 3])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector("Combo Order", COMBO_SPELLS, defaultCombo)

		for (const spell of COMBO_SPELLS) {
			if (!this.comboSequenceGrid.enabledValues.has(spell)) {
				this.comboSequenceGrid.enabledValues.set(spell, [
					spell !== "juggernaut_healing_ward",
					spell !== "juggernaut_healing_ward",
					spell !== "juggernaut_healing_ward",
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
		EventsSDK.on("GameStarted", this.onGameEnded.bind(this))
		EventsSDK.on("PrepareUnitOrders", this.onPrepareUnitOrders.bind(this))
	}

	private onGameEnded(): void {
		this.sleeper.ResetTimer()
		this.wardSleeper.ResetTimer()
		this.lockedTarget = undefined
		this.lastBladeFuryMovePos = undefined
		this.lastBladeFuryMoveTime = 0
		this.currentBlockTargetPos = undefined
		this.pSDK.DestroyAll()
	}

	private get hasLocalHero(): boolean {
		return Boolean(
			LocalPlayer &&
				LocalPlayer.Hero &&
				LocalPlayer.Hero.IsValid &&
				LocalPlayer.Hero.Name === "npc_dota_hero_juggernaut"
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

	private isBladeFury(hero: Hero): boolean {
		return hero.HasBuffByName("modifier_juggernaut_blade_fury")
	}

	private isSlashing(hero: Hero): boolean {
		return (
			hero.HasBuffByName("modifier_juggernaut_omnislash") ||
			hero.HasBuffByName("modifier_juggernaut_omnislash_invulnerability") ||
			hero.HasBuffByName("modifier_juggernaut_swiftslash")
		)
	}

	/**
	 * Order interceptor:
	 * During Blade Fury, strictly block all player attack orders to prevent attack animation stutter.
	 */
	private onPrepareUnitOrders(order: ExecuteOrder): false | void {
		if (!this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (this.isBladeFury(hero)) {
			if (
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_MOVE
			) {
				// If combo key is held, completely block manual attack orders so they don't disrupt the body block path
				// @ts-ignore
				if (this.comboKey.isPressed) {
					return false
				}

				// Convert to move order to target position outside combo key
				if (order.Target && order.Target instanceof Unit && order.Target.IsValid) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
						issuers: [hero],
						position: order.Target.Position,
						queue: false,
						showEffects: false,
						isPlayerInput: false
					})
				}
				return false
			}
		}
	}

	private OnDraw(): void {
		if (this.comboSequenceGrid) {
			let dirty = false
			for (const spell of COMBO_SPELLS) {
				if (!this.comboSequenceGrid.enabledValues.has(spell)) {
					this.comboSequenceGrid.enabledValues.set(spell, [
						spell !== "juggernaut_healing_ward",
						spell !== "juggernaut_healing_ward",
						spell !== "juggernaut_healing_ward",
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

		// Draw Blade Fury radius indicator
		if (this.drawBladeFuryRadius.value && this.isBladeFury(hero)) {
			const heroScreenPos = RendererSDK.WorldToScreen(hero.Position)
			if (heroScreenPos) {
				RendererSDK.OutlinedCircle(heroScreenPos, new Vector2(260, 260), Color.Orange, 2)
			}
		}

		// Draw Body Block target indicator
		if (this.drawBodyBlockPos.value && this.isBladeFury(hero) && this.currentBlockTargetPos && this.lockedTarget) {
			const blockScreenPos = RendererSDK.WorldToScreen(this.currentBlockTargetPos)
			const targetScreenPos = RendererSDK.WorldToScreen(this.lockedTarget.Position)
			if (blockScreenPos) {
				RendererSDK.OutlinedCircle(blockScreenPos, new Vector2(28, 28), Color.Aqua, 2)
				if (targetScreenPos) {
					RendererSDK.Line(targetScreenPos, blockScreenPos, Color.Aqua.SetA(180), 2)
				}
			}
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		if (this.sleeper.lastSleepTickCount > (GameState.RawGameTime + 60) * 1000) {
			this.sleeper.ResetTimer()
			this.wardSleeper.ResetTimer()
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("jugg_target_ring")
			return
		}

		// 1. Maintain Healing Ward follow controller
		this.handleHealingWardFollow(hero)

		// 2. Check if Combo Key is held
		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("jugg_target_ring")
			return
		}

		if (hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// 3. Target Selection & Locking
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
			this.pSDK.DestroyByKey("jugg_target_ring")
			return
		}

		this.pSDK.DrawCircle("jugg_target_ring", bestTarget, 140, {
			Color: new Color(255, 120, 0, 220),
			Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
		})

		// 4. If currently in Omnislash or Swiftslash, execute items only, do not issue move/attack orders
		if (this.isSlashing(hero)) {
			this.executeOffensiveItems(hero, bestTarget, true)
			return
		}

		// 5. Special Blade Fury Mode: Strictly NO ATTACKS, ONLY MOVE & BODY BLOCK
		if (this.isBladeFury(hero)) {
			this.handleBladeFuryChase(hero, bestTarget)
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// 6. Execute Gap Closers & Items
		if (this.executeItems(hero, bestTarget, isTargetImmune)) {
			return
		}

		// 7. Execute Skill Rotation
		if (this.comboSequenceGrid) {
			for (const actionName of this.comboSequenceGrid.values) {
				if (!this.comboSequenceGrid.IsEnabled(actionName)) {
					continue
				}

				// A. OMNISLASH
				if (actionName === "juggernaut_omni_slash") {
					const omni = hero.GetAbilityByName("juggernaut_omni_slash")
					if (omni && omni.IsValid && omni.Level > 0 && omni.Cooldown <= 0.1 && hero.Mana >= omni.ManaCost) {
						const castRange = omni.CastRange > 0 ? omni.CastRange : 350
						if (hero.Distance2D(bestTarget) <= castRange + 100) {
							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: omni.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + omni.CastPoint * 1000 + 150)
							return
						}
					}
				}

				// B. SWIFTSLASH (Aghanim's Scepter)
				else if (actionName === "juggernaut_swift_slash") {
					const swift = hero.GetAbilityByName("juggernaut_swift_slash")
					if (
						swift &&
						swift.IsValid &&
						swift.Level > 0 &&
						swift.Cooldown <= 0.1 &&
						hero.Mana >= swift.ManaCost &&
						!swift.IsHidden
					) {
						const castRange = swift.CastRange > 0 ? swift.CastRange : 650
						if (hero.Distance2D(bestTarget) <= castRange + 100) {
							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: swift.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + swift.CastPoint * 1000 + 150)
							return
						}
					}
				}

				// C. BLADE FURY
				else if (actionName === "juggernaut_blade_fury") {
					const fury = hero.GetAbilityByName("juggernaut_blade_fury")
					if (fury && fury.IsValid && fury.Level > 0 && fury.Cooldown <= 0.1 && hero.Mana >= fury.ManaCost) {
						const furyRadius = 260
						const dist = hero.Distance2D(bestTarget)

						// Cast Blade Fury if in radius or closing in, and target is not dead
						if (dist <= furyRadius + 120) {
							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
								issuers: [hero],
								ability: fury.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
							return
						}
					}
				}

				// D. HEALING WARD (Manual Combo Option)
				else if (actionName === "juggernaut_healing_ward") {
					const ward = hero.GetAbilityByName("juggernaut_healing_ward")
					if (ward && ward.IsValid && ward.Level > 0 && ward.Cooldown <= 0.1 && hero.Mana >= ward.ManaCost) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: hero.Position,
							ability: ward.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + ward.CastPoint * 1000 + 150)
						return
					}
				}
			}
		}

		// 8. Smart Orb Walk (Normal Right-Click Attacks Outside Blade Fury)
		if (this.smartOrbWalkEnabled.value) {
			executeOrbwalk(hero, bestTarget, this.sleeper, {
				enabled: this.smartOrbWalkEnabled.value,
				safeDistancePct: this.smartOrbWalkDistancePct.value,
				stopToCancel: false
			})
		}
	}

	// Special Blade Fury Chase & Body Block Controller:
	// Strictly NO attack orders.
	// 1. Overtake & Intercept: When behind the enemy, aims well ahead (200-360 units) along the escape route.
	//    If not phased, adds a lateral offset (flanking) so Juggernaut slides past the enemy's shoulder.
	// 2. Active Body Block: Once in front, positions directly in front of the enemy's nose (45-60 units).
	// 3. Items: Slows with Diffusal/Disperser, activates Phase Boots when catching up, and Blinks ahead if needed.
	private handleBladeFuryChase(hero: Hero, target: Hero): void {
		// 1. Offensive & Mobility Items during Blade Fury
		this.executeBladeFuryItems(hero, target)

		if (this.sleeper.Sleeping) {
			return
		}

		const targetIsMoving = target.IsMoving && target.MoveSpeed > 50 && !target.IsStunned && !target.IsRooted

		// If target is stopped/stunned or body blocking disabled, move straight to target
		if (!targetIsMoving || !this.bodyBlockEnabled.value) {
			this.currentBlockTargetPos = target.Position.Clone()
			this.issueBladeFuryMove(hero, this.currentBlockTargetPos, 100)
			return
		}

		// 2. Relative Geometry & Coordinate Decomposition
		const targetDir = target.Forward
		const toJugg = hero.Position.Subtract(target.Position)
		const forwardDist = toJugg.x * targetDir.x + toJugg.y * targetDir.y // >0 ahead, <0 behind
		const perp = new Vector3(-targetDir.y, targetDir.x, 0)
		const lateralDist = toJugg.x * perp.x + toJugg.y * perp.y // offset to side

		const isPhased =
			hero.HasBuffByName("modifier_item_phase_boots_active") ||
			hero.HasBuffByName("modifier_item_disperser_active")

		let moveDest: Vector3

		// STATE A: Juggernaut is BEHIND the target (Overtake & Intercept)
		if (forwardDist < 35) {
			// Look far ahead on target's path (where enemy will be in ~0.65s)
			const overtakeDist = Math.max(220, Math.min(360, target.MoveSpeed * 0.75))
			const aheadPoint = target.Position.Add(targetDir.MultiplyScalar(overtakeDist))

			if (isPhased) {
				// Phased: can slip straight through enemy
				moveDest = aheadPoint
			} else {
				// Not phased: if directly behind, steer slightly to side
				// to pass around enemy's shoulder instead of hitting back hull
				const side = lateralDist >= 0 ? 1 : -1
				moveDest = aheadPoint.Add(perp.MultiplyScalar(side * 50))
			}
		}
		// STATE B: Juggernaut is IN FRONT of the target (Active Body Block)
		else {
			const desiredBlockDist = this.bodyBlockLeadDist.value // default 55 units in front of center
			// In the sweet block zone! Stand dead-center in front of enemy's path
			moveDest = target.Position.Add(targetDir.MultiplyScalar(desiredBlockDist))
		}

		this.currentBlockTargetPos = moveDest
		this.issueBladeFuryMove(hero, moveDest, 90)
	}

	private issueBladeFuryMove(hero: Hero, position: Vector3, minSleepMs = 90): void {
		const now = GameState.RawGameTime
		// Anti-stutter: only send new order if position changed by > 20 units or > 140ms elapsed
		if (
			this.lastBladeFuryMovePos &&
			this.lastBladeFuryMovePos.Distance2D(position) < 20 &&
			now - this.lastBladeFuryMoveTime < 0.14
		) {
			return
		}

		this.lastBladeFuryMovePos = position.Clone()
		this.lastBladeFuryMoveTime = now

		claimOrder()
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
			issuers: [hero],
			position,
			queue: false,
			showEffects: false,
			isPlayerInput: false
		})

		this.sleeper.Sleep(GameState.InputLag * 1000 + minSleepMs)
	}

	private executeBladeFuryItems(hero: Hero, target: Hero): void {
		const dist = hero.Distance2D(target)
		const isTargetImmune = target.IsMagicImmune || target.IsDebuffImmune

		// 1. BLINK DAGGER (During Blade Fury if target is getting away)
		if (this.itemsSelector.IsEnabled("item_blink") && this.blinkMode.SelectedID !== 2 && dist > 350) {
			const blink =
				this.getItem(hero, "item_blink") ||
				this.getItem(hero, "item_swift_blink") ||
				this.getItem(hero, "item_arcane_blink") ||
				this.getItem(hero, "item_overwhelming_blink")

			if (blink && blink.Cooldown <= 0.1) {
				const blinkRange = blink.CastRange > 0 ? blink.CastRange : 1200
				let blinkPos = target.Position.Clone()
				if (target.IsMoving) {
					blinkPos = target.InFront(100)
				}
				if (hero.Distance2D(blinkPos) <= blinkRange) {
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
					return
				}
			}
		}

		// 2. PHASE BOOTS & DISPERSER (Speed & Phase)
		if (this.autoPhaseInBladeFury.value) {
			const toJugg = hero.Position.Subtract(target.Position)
			const forwardDist = toJugg.x * target.Forward.x + toJugg.y * target.Forward.y

			// Activate Phase Boots when catching up (behind or > 140 distance)
			// When already blocking in front, keep solid collision
			if (forwardDist < 40 || dist > 140) {
				const phase = this.getItem(hero, "item_phase_boots")
				if (phase && phase.Cooldown <= 0.1) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: phase.Index,
						queue: false,
						showEffects: false,
						isPlayerInput: false
					})
				}

				const disperser = this.getItem(hero, "item_disperser")
				if (disperser && disperser.Cooldown <= 0.1 && hero.Mana >= disperser.ManaCost) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: hero.Index,
						ability: disperser.Index,
						queue: false,
						showEffects: false,
						isPlayerInput: false
					})
				}
			}
		}

		// 3. DIFFUSAL BLADE / DISPERSER TARGET SLOW
		if (
			(this.itemsSelector.IsEnabled("item_diffusal_blade") || this.itemsSelector.IsEnabled("item_disperser")) &&
			!isTargetImmune &&
			dist <= 600
		) {
			const diffusal = this.getItem(hero, "item_disperser") || this.getItem(hero, "item_diffusal_blade")
			if (diffusal && diffusal.Cooldown <= 0.1 && hero.Mana >= diffusal.ManaCost) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: diffusal.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return
			}
		}

		// 4. ABYSSAL BLADE
		if (this.itemsSelector.IsEnabled("item_abyssal_blade") && !isTargetImmune && dist <= 600) {
			const abyssal = this.getItem(hero, "item_abyssal_blade")
			if (abyssal && abyssal.Cooldown <= 0.1 && hero.Mana >= abyssal.ManaCost) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: abyssal.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return
			}
		}

		// 5. NULLIFIER
		if (this.itemsSelector.IsEnabled("item_nullifier") && !isTargetImmune && dist <= 800) {
			const nullifier = this.getItem(hero, "item_nullifier")
			if (nullifier && nullifier.Cooldown <= 0.1 && hero.Mana >= nullifier.ManaCost) {
				const hasGhostBuff =
					target.HasBuffByName("modifier_item_ghost_scepter") ||
					target.HasBuffByName("modifier_item_ethereal_blade") ||
					target.HasBuffByName("modifier_eul_cyclone") ||
					target.HasBuffByName("modifier_wind_waker")

				if (hasGhostBuff) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: target.Index,
						ability: nullifier.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				}
			}
		}
	}

	/**
	 * Ensures Healing Ward continuously follows Juggernaut so it stays safe and keeps healing.
	 */
	private handleHealingWardFollow(hero: Hero): void {
		if (!this.wardAutoFollow.value || this.wardSleeper.Sleeping) {
			return
		}

		const localPlayerId = LocalPlayer?.PlayerID ?? -1
		for (const unit of EntityManager.GetEntitiesByClass(Unit)) {
			if (
				unit &&
				unit.IsValid &&
				unit.IsAlive &&
				unit.Name === "npc_dota_juggernaut_healing_ward" &&
				unit.PlayerID === localPlayerId
			) {
				if (unit.Position.Distance2D(hero.Position) > 120) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_TARGET,
						issuers: [unit],
						target: hero.Index,
						queue: false,
						showEffects: false,
						isPlayerInput: false
					})
				}
			}
		}

		this.wardSleeper.Sleep(350)
	}

	/**
	 * Offense & Utility Items Execution.
	 */
	private executeItems(hero: Hero, bestTarget: Hero, isTargetImmune: boolean): boolean {
		// 1. BLINK DAGGER
		if (this.itemsSelector.IsEnabled("item_blink") && this.blinkMode.SelectedID !== 2) {
			const dist = hero.Distance2D(bestTarget)
			const attackRange = hero.GetAttackRange(bestTarget) || 150

			if (dist > attackRange + 250) {
				const blink =
					this.getItem(hero, "item_blink") ||
					this.getItem(hero, "item_swift_blink") ||
					this.getItem(hero, "item_arcane_blink") ||
					this.getItem(hero, "item_overwhelming_blink")

				if (blink && blink.Cooldown <= 0.1) {
					const blinkRange = blink.CastRange > 0 ? blink.CastRange : 1200
					let blinkPos = bestTarget.Position.Clone()

					if (this.blinkMode.SelectedID === 1 && dist > blinkRange) {
						const dir = bestTarget.Position.Subtract(hero.Position).Normalize()
						blinkPos = hero.Position.Add(dir.MultiplyScalar(blinkRange))
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

		// 2. PHASE BOOTS (Approach)
		if (this.itemsSelector.IsEnabled("item_phase_boots")) {
			const phase = this.getItem(hero, "item_phase_boots")
			if (phase && phase.Cooldown <= 0.1 && hero.Distance2D(bestTarget) > 200) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: phase.Index,
					queue: false,
					showEffects: false,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
				return true
			}
		}

		// 3. BLACK KING BAR
		if (this.itemsSelector.IsEnabled("item_black_king_bar") && !this.isBladeFury(hero)) {
			const bkb = this.getItem(hero, "item_black_king_bar")
			if (bkb && bkb.Cooldown <= 0.1 && hero.Distance2D(bestTarget) <= 650) {
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

		return this.executeOffensiveItems(hero, bestTarget, isTargetImmune)
	}

	/**
	 * Items that can also be safely cast during Omnislash or regular chase.
	 */
	private executeOffensiveItems(hero: Hero, bestTarget: Hero, isTargetImmune: boolean): boolean {
		const dist = hero.Distance2D(bestTarget)

		// NULLIFIER (Counters Ghost Scepter, Eul's Scepter, Force Staff, Wind Waker)
		if (this.itemsSelector.IsEnabled("item_nullifier") && !isTargetImmune) {
			const nullifier = this.getItem(hero, "item_nullifier")
			if (nullifier && nullifier.Cooldown <= 0.1 && hero.Mana >= nullifier.ManaCost && dist <= 900) {
				const hasGhostBuff =
					bestTarget.HasBuffByName("modifier_item_ghost_scepter") ||
					bestTarget.HasBuffByName("modifier_item_ethereal_blade") ||
					bestTarget.HasBuffByName("modifier_eul_cyclone") ||
					bestTarget.HasBuffByName("modifier_wind_waker")

				if (hasGhostBuff || this.isSlashing(hero) || dist <= 600) {
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
		}

		// ABYSSAL BLADE
		if (this.itemsSelector.IsEnabled("item_abyssal_blade") && !isTargetImmune) {
			const abyssal = this.getItem(hero, "item_abyssal_blade")
			if (abyssal && abyssal.Cooldown <= 0.1 && hero.Mana >= abyssal.ManaCost && dist <= 600) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: abyssal.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// DIFFUSAL BLADE / DISPERSER (Target Slow)
		if (
			(this.itemsSelector.IsEnabled("item_diffusal_blade") || this.itemsSelector.IsEnabled("item_disperser")) &&
			!isTargetImmune
		) {
			const diffusal = this.getItem(hero, "item_disperser") || this.getItem(hero, "item_diffusal_blade")
			if (diffusal && diffusal.Cooldown <= 0.1 && hero.Mana >= diffusal.ManaCost && dist <= 600) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: diffusal.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// BLOODTHORN / ORCHID
		if (
			(this.itemsSelector.IsEnabled("item_bloodthorn") || this.itemsSelector.IsEnabled("item_orchid")) &&
			!isTargetImmune
		) {
			const orchid = this.getItem(hero, "item_bloodthorn") || this.getItem(hero, "item_orchid")
			if (orchid && orchid.Cooldown <= 0.1 && hero.Mana >= orchid.ManaCost && dist <= 800) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: bestTarget.Index,
					ability: orchid.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// MANTA STYLE
		if (this.itemsSelector.IsEnabled("item_manta")) {
			const manta = this.getItem(hero, "item_manta")
			if (manta && manta.Cooldown <= 0.1 && hero.Mana >= manta.ManaCost && dist <= 500) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: manta.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// MJOLLNIR (Self Cast Static Shield)
		if (this.itemsSelector.IsEnabled("item_mjollnir")) {
			const mjollnir = this.getItem(hero, "item_mjollnir")
			if (
				mjollnir &&
				mjollnir.Cooldown <= 0.1 &&
				hero.Mana >= mjollnir.ManaCost &&
				dist <= 600 &&
				!hero.HasBuffByName("modifier_item_mjollnir_static")
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: hero.Index,
					ability: mjollnir.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// SATANIC (Low HP Trigger)
		if (this.itemsSelector.IsEnabled("item_satanic")) {
			const satanic = this.getItem(hero, "item_satanic")
			if (satanic && satanic.Cooldown <= 0.1 && (hero.HP / hero.MaxHP) * 100 <= 40 && dist <= 400) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: satanic.Index,
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
})()
