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
	"item_ethereal_blade",
	"item_essence_distiller",
	"item_spirit_vessel",
	"item_urn_of_shadows",
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
			["item_ethereal_blade", true],
			["item_essence_distiller", true],
			["item_spirit_vessel", true],
			["item_urn_of_shadows", true],
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
	private currentBlockTargetPos: Vector3 | undefined = undefined
	private bladeFuryZigzagSide = 1
	private lastBladeFuryTargetDir: Vector3 | undefined = undefined

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
		this.currentBlockTargetPos = undefined
		this.bladeFuryZigzagSide = 1
		this.lastBladeFuryTargetDir = undefined
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
				// Strictly convert ANY attack order during Blade Fury into a pure MOVE order!
				// When combo key is held, move to the body block target position.
				// Outside combo key, move to target unit's position.
				// This guarantees the hero NEVER attempts an attack animation during Blade Fury!
				claimOrder()
				const movePos =
					(this.currentBlockTargetPos && this.currentBlockTargetPos.Clone()) ||
					(order.Target && order.Target instanceof Unit && order.Target.IsValid
						? order.Target.Position.Clone()
						: hero.Position.Add(hero.Forward.MultiplyScalar(50)))

				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
					issuers: [hero],
					position: movePos,
					queue: false,
					showEffects: false,
					isPlayerInput: false
				})
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

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// 4. If currently in Omnislash or Swiftslash, execute items only, do not issue move/attack orders
		if (this.isSlashing(hero)) {
			this.executeOffensiveItems(hero, bestTarget, isTargetImmune)
			return
		}

		// 5. Special Blade Fury Mode: Strictly NO ATTACKS, ONLY MOVE & BODY BLOCK
		if (this.isBladeFury(hero)) {
			this.handleBladeFuryChase(hero, bestTarget)
			return
		}
		this.lastBladeFuryTargetDir = undefined

		if (this.sleeper.Sleeping) {
			return
		}

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

	/**
	 * Mathematically guarantees that any movement vector from hero.Position
	 * ALWAYS has a positive forward component along the target's movement direction,
	 * with the lateral turning angle strictly clamped to maxAngleDeg (default 24°).
	 * This makes it impossible for Juggernaut to face backwards or turn > 90°.
	 */
	private getForwardTarget(
		heroPos: Vector3,
		targetDir: Vector3,
		targetPerp: Vector3,
		stepFwd: number,
		desiredLat: number,
		maxAngleDeg = 24
	): Vector3 {
		const fwd = Math.max(stepFwd, 10)
		const maxLat = fwd * Math.tan((maxAngleDeg * Math.PI) / 180)
		const lat = Math.max(-maxLat, Math.min(maxLat, desiredLat))
		return heroPos.Add(targetDir.MultiplyScalar(fwd)).Add(targetPerp.MultiplyScalar(lat))
	}

	private issueBladeFuryMove(hero: Hero, position: Vector3, minSleepMs = 60): void {
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

	// Special Blade Fury Chase & Body Block Controller:
	// STRICTLY ZERO ATTACK ORDERS, ZERO ORDER_STOP!
	// In Dota 2, calling OrderStop or attacking during Blade Fury triggers auto-attack animations
	// and deals 0 physical damage while locking the hero in attack-cancel stutter.
	// We use 100% pure MOVE_TO_POSITION commands with rapid micro-weaving to maintain
	// unbreakable collision hull obstruction directly on the enemy's nose.
	private handleBladeFuryChase(hero: Hero, target: Hero): void {
		// 1. Offensive & Mobility Items during Blade Fury
		this.executeBladeFuryItems(hero, target)

		const targetIsMoving = target.IsMoving && target.MoveSpeed > 50 && !target.IsStunned && !target.IsRooted

		// If target is stopped/stunned/rooted or body blocking disabled, move straight to target position
		if (!targetIsMoving || !this.bodyBlockEnabled.value) {
			this.lastBladeFuryTargetDir = undefined
			if (this.sleeper.Sleeping) {
				return
			}
			this.currentBlockTargetPos = target.Position.Clone()
			this.issueBladeFuryMove(hero, this.currentBlockTargetPos, 60)
			return
		}

		// 2. Resolve Target Movement Direction
		let rawTargetDir = target.Forward.Clone().SetZ(0)
		rawTargetDir =
			rawTargetDir.Length2D < 0.05 ? hero.Forward.Clone().SetZ(0).Normalize() : rawTargetDir.Normalize()

		// 3. Instant Gocek / Juke Detection (Zero sluggish smoothing!)
		// If target turns sharply (> 60 degrees) or reverses (180 degrees)
		if (this.lastBladeFuryTargetDir) {
			const turnDot = rawTargetDir.Dot(this.lastBladeFuryTargetDir)
			if (turnDot < 0.5) {
				// Enemy just juked / reversed direction!
				// Reset sleeper immediately so Juggernaut reacts on this exact frame!
				this.sleeper.ResetTimer()
			}
		}
		this.lastBladeFuryTargetDir = rawTargetDir.Clone()

		if (this.sleeper.Sleeping) {
			return
		}

		const targetDir = this.lastBladeFuryTargetDir
		const targetPerp = new Vector3(-targetDir.y, targetDir.x, 0)

		// 4. Calculate Hero's Forward Progress vs Target (identical to creep_blocker leadDelta)
		const heroProg = hero.Position.x * targetDir.x + hero.Position.y * targetDir.y
		const targetProg = target.Position.x * targetDir.x + target.Position.y * targetDir.y
		const leadDelta = heroProg - targetProg

		// Lateral offset crosswise to target's heading
		const toHero = hero.Position.Subtract(target.Position)
		toHero.SetZ(0)
		const latDiff = toHero.x * targetPerp.x + toHero.y * targetPerp.y

		const isPhased =
			hero.HasBuffByName("modifier_item_phase_boots_active") ||
			hero.HasBuffByName("modifier_item_disperser_active")

		// =========================================================================
		// SCENARIO 1: OVERTAKE (Hero is behind or enemy just reversed/goceked! leadDelta < 32)
		// Hero CANNOT stop! Hero MUST sprint at full movespeed with boots!
		// =========================================================================
		if (leadDelta < 32) {
			let overtakePos: Vector3

			if (isPhased) {
				// Phased movement: can pass straight through enemy model to cut them off
				overtakePos = this.getForwardTarget(hero.Position, targetDir, targetPerp, 55, 0, 15)
			} else {
				// Not phased: flank laterally (42 units clearance) to sprint alongside without rear hull drag!
				const flankSide = latDiff >= 0 ? 1 : -1
				const desiredLatOffset = flankSide * 42 - latDiff
				overtakePos = this.getForwardTarget(hero.Position, targetDir, targetPerp, 50, desiredLatOffset, 25)
			}

			this.currentBlockTargetPos = overtakePos.Clone()
			this.issueBladeFuryMove(hero, overtakePos, 55)
			return
		}

		// =========================================================================
		// SCENARIO 2: CUTTING IN (Hero is ahead, but off to the side, |latDiff| > 18)
		// leadDelta >= 32, but |latDiff| > 18:
		// Step forward and inward into the enemy's escape path! NEVER step backwards!
		// =========================================================================
		if (Math.abs(latDiff) > 18) {
			const inwardPull = -latDiff * 0.7
			const cutInPos = this.getForwardTarget(hero.Position, targetDir, targetPerp, 28, inwardPull, 24)

			this.currentBlockTargetPos = cutInPos.Clone()
			this.issueBladeFuryMove(hero, cutInPos, 50)
			return
		}

		// =========================================================================
		// SCENARIO 3: HERO IS TOO FAR AHEAD (leadDelta > 48 and |latDiff| <= 18)
		// Touching distance is 48 (24 + 24). If leadDelta > 48, hero pulled too far ahead!
		// DO NOT run further ahead! Slow down by crawling 4 units so enemy catches up into our back!
		// STRICTLY ZERO OrderStop to prevent auto-attack animation stutter!
		// =========================================================================
		if (leadDelta > 48) {
			const crawlPos = this.getForwardTarget(hero.Position, targetDir, targetPerp, 4, -latDiff * 0.2, 10)
			this.currentBlockTargetPos = crawlPos.Clone()
			this.issueBladeFuryMove(hero, crawlPos, 70)
			return
		}

		// =========================================================================
		// SCENARIO 4: ACTIVE BODY BLOCKING (32 <= leadDelta <= 48 and |latDiff| <= 18)
		// Hero is safely in front, in physical collision hull contact (distance 32..48)!
		// Keep hero in continuous micro-movement directly on enemy's nose with lateral weave:
		// STRICTLY ZERO ATTACK ORDERS, ZERO ORDER_STOP!
		// =========================================================================
		if (isPhased) {
			// If phased, hero has no collision hull, so stay glued on front bumper
			const phasedPos = this.getForwardTarget(hero.Position, targetDir, targetPerp, 18, -latDiff * 0.4, 15)
			this.currentBlockTargetPos = phasedPos.Clone()
			this.issueBladeFuryMove(hero, phasedPos, 55)
			return
		}

		// Micro-step forward matching enemy's pace while sweeping laterally across their path:
		this.bladeFuryZigzagSide = -this.bladeFuryZigzagSide
		const lateralWeave = this.bladeFuryZigzagSide * 8 - latDiff * 0.4
		// Step forward by 10..14 units matching the enemy's pace while sweeping across their path
		const stepFwd = Math.max(8, Math.min(14, 46 - leadDelta + 6))
		const stepPos = this.getForwardTarget(hero.Position, targetDir, targetPerp, stepFwd, lateralWeave, 18)

		this.currentBlockTargetPos = stepPos.Clone()
		this.issueBladeFuryMove(hero, stepPos, 60)
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
					return
				}
			}
		}

		// 6. ETHEREAL BLADE (Amplifies Blade Fury Magic Damage + Massive Slow)
		if (this.itemsSelector.IsEnabled("item_ethereal_blade") && !isTargetImmune && dist <= 800) {
			const eblade = this.getItem(hero, "item_ethereal_blade")
			if (
				eblade &&
				eblade.Cooldown <= 0.1 &&
				hero.Mana >= eblade.ManaCost &&
				!target.HasBuffByName("modifier_item_ethereal_blade_ethereal") &&
				!target.HasBuffByName("modifier_item_ethereal_blade")
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: eblade.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return
			}
		}

		// 7. ESSENCE DISTILLER (Ground Target)
		if (this.itemsSelector.IsEnabled("item_essence_distiller")) {
			const distiller = this.getItem(hero, "item_essence_distiller")
			if (distiller && distiller.Cooldown <= 0.1 && hero.Mana >= distiller.ManaCost) {
				const castRange = distiller.CastRange > 0 ? distiller.CastRange : 750
				if (dist <= castRange + 150) {
					const castPos = target.IsMoving ? target.InFront(60) : target.Position.Clone()
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: castPos,
						ability: distiller.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
					return
				}
			}
		}

		// 8. URN OF SHADOWS / SPIRIT VESSEL
		if (
			(this.itemsSelector.IsEnabled("item_spirit_vessel") ||
				this.itemsSelector.IsEnabled("item_urn_of_shadows")) &&
			!isTargetImmune &&
			dist <= 950
		) {
			const vessel = this.getItem(hero, "item_spirit_vessel") || this.getItem(hero, "item_urn_of_shadows")
			if (
				vessel &&
				vessel.Cooldown <= 0.1 &&
				vessel.CurrentCharges > 0 &&
				hero.Mana >= vessel.ManaCost &&
				!target.HasBuffByName("modifier_item_spirit_vessel_damage") &&
				!target.HasBuffByName("modifier_item_urn_damage")
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: vessel.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
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

		// ETHEREAL BLADE (Do not use during Omnislash/Swiftslash to avoid physical attack immunity)
		if (
			this.itemsSelector.IsEnabled("item_ethereal_blade") &&
			!isTargetImmune &&
			!this.isSlashing(hero) &&
			dist <= 800
		) {
			const eblade = this.getItem(hero, "item_ethereal_blade")
			if (
				eblade &&
				eblade.Cooldown <= 0.1 &&
				hero.Mana >= eblade.ManaCost &&
				!bestTarget.HasBuffByName("modifier_item_ethereal_blade_ethereal") &&
				!bestTarget.HasBuffByName("modifier_item_ethereal_blade")
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

		// ESSENCE DISTILLER (Ground Target - Armor reduction & damage)
		if (this.itemsSelector.IsEnabled("item_essence_distiller")) {
			const distiller = this.getItem(hero, "item_essence_distiller")
			if (distiller && distiller.Cooldown <= 0.1 && hero.Mana >= distiller.ManaCost) {
				const castRange = distiller.CastRange > 0 ? distiller.CastRange : 750
				if (dist <= castRange + 150) {
					const castPos = bestTarget.IsMoving ? bestTarget.InFront(60) : bestTarget.Position.Clone()
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: castPos,
						ability: distiller.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
					return true
				}
			}
		}

		// URN OF SHADOWS / SPIRIT VESSEL
		if (
			(this.itemsSelector.IsEnabled("item_spirit_vessel") ||
				this.itemsSelector.IsEnabled("item_urn_of_shadows")) &&
			!isTargetImmune &&
			dist <= 950
		) {
			const vessel = this.getItem(hero, "item_spirit_vessel") || this.getItem(hero, "item_urn_of_shadows")
			if (
				vessel &&
				vessel.Cooldown <= 0.1 &&
				vessel.CurrentCharges > 0 &&
				hero.Mana >= vessel.ManaCost &&
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
