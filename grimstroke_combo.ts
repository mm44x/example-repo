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

import { claimOrder, isRealHero } from "./coordination"
import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = [
	"grimstroke_soulbind",
	"grimstroke_dark_portrait",
	"grimstroke_spirit_walk",
	"grimstroke_ink_creature",
	"grimstroke_dark_artistry"
]

const COMBO_ITEMS = [
	"item_blink",
	"item_arcane_blink",
	"item_swift_blink",
	"item_overwhelming_blink",
	"item_sheepstick",
	"item_bloodthorn",
	"item_orchid",
	"item_ethereal_blade",
	"item_dagon",
	"item_nullifier",
	"item_rod_of_atos",
	"item_gungir",
	"item_heavens_halberd",
	"item_shivas_guard",
	"item_veil_of_discord",
	"item_spirit_vessel",
	"item_urn_of_shadows",
	"item_black_king_bar",
	"item_diffusal_blade",
	"item_disperser",
	"item_abyssal_blade"
]

new (class GrimstrokeCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Grimstroke Combo", "panorama/images/heroes/icons/npc_dota_hero_grimstroke_png.vtex_c", "", 0)

	// Combo Controls
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute full Grimstroke combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 1000, 400, 1600, 0)
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"Locks onto a single target hero when holding the combo key"
	)

	// Dynamic Skill Order (Combo Sequence)
	private comboSequenceGrid: any

	// Stroke of Fate (Q) Settings
	private readonly strokeNode = this.entry.AddNode("Stroke of Fate (Q)")
	private readonly strokeMode = this.strokeNode.AddDropdown(
		"Stroke of Fate Mode",
		["Auto / Alt-Cast (Straight Line)", "Normal Cast (Curved)", "Conditional (Auto Switch)"],
		0,
		"Alt-Cast fires a straight linear projectile with movement prediction (similar to Puck Illusory Orb)"
	)
	private readonly strokeHarassEnabled = this.strokeNode.AddToggle(
		"Enable Harass / Snipe Key",
		true,
		"Enable a dedicated hotkey to aim and fire Stroke of Fate independently outside combo"
	)
	private readonly strokeHarassKey = this.strokeNode.AddKeybind(
		"Harass / Snipe Key",
		"G",
		"Hold to predict and cast Stroke of Fate at nearest enemy to cursor"
	)
	private readonly drawStrokePrediction = this.strokeNode.AddToggle(
		"Draw Stroke Trajectory & Prediction",
		true,
		"Visualizes predicted projectile path and target intercept point"
	)

	// Ink Swell (E) Settings
	private readonly inkSwellNode = this.entry.AddNode("Ink Swell (E)")
	private readonly inkSwellTargetingMode = this.inkSwellNode.AddDropdown(
		"Targeting Hierarchy",
		["Smart Hierarchy (Blocker Illusion > Closer Ally > Self)", "Always Self"],
		0,
		"Chooses the best target: body-blocking illusion, closer ally, or Grimstroke himself"
	)
	private readonly inkSwellSweetSpotMin = this.inkSwellNode.AddSlider(
		"Sweet Spot Min Distance",
		150,
		50,
		300,
		0,
		"Minimum desired distance to target during Ink Swell (well inside 375 explosion AoE)"
	)
	private readonly inkSwellSweetSpotMax = this.inkSwellNode.AddSlider(
		"Sweet Spot Max Distance",
		250,
		150,
		350,
		0,
		"Maximum desired distance to target during Ink Swell (well inside 375 explosion AoE)"
	)
	private readonly drawInkSwellRadius = this.inkSwellNode.AddToggle(
		"Draw Ink Swell 375 Radius",
		true,
		"Draw 375 explosion radius around unit carrying Ink Swell buff"
	)

	// Dark Portrait & Soulbind Illusions Settings
	private readonly darkPortraitNode = this.entry.AddNode("Dark Portrait & Illusions")
	private readonly autoControlIllusions = this.darkPortraitNode.AddToggle(
		"Auto Control Dark Portrait Illusions",
		true,
		"Automatically manages 2-illusion synergy: highest DPS attacks, secondary body blocks"
	)
	private readonly drawIllusionRoles = this.darkPortraitNode.AddToggle(
		"Draw Illusion Role Markers",
		true,
		"Display visual tags for Attacker (DPS) and Blocker illusions"
	)
	private readonly drawBlockMarker = this.darkPortraitNode.AddToggle(
		"Draw Body Block Marker",
		true,
		"Draw visual marker at the predicted cutoff/body block location"
	)

	// Items Integration
	private readonly itemsNode = this.entry.AddNode("Items Integration")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Use Items",
		COMBO_ITEMS,
		new Map([
			["item_blink", true],
			["item_arcane_blink", true],
			["item_swift_blink", true],
			["item_overwhelming_blink", true],
			["item_sheepstick", true],
			["item_bloodthorn", true],
			["item_orchid", true],
			["item_ethereal_blade", true],
			["item_dagon", true],
			["item_nullifier", true],
			["item_rod_of_atos", true],
			["item_gungir", true],
			["item_heavens_halberd", true],
			["item_shivas_guard", true],
			["item_veil_of_discord", true],
			["item_spirit_vessel", true],
			["item_urn_of_shadows", true],
			["item_black_king_bar", true],
			["item_diffusal_blade", true],
			["item_disperser", true],
			["item_abyssal_blade", true]
		]),
		"Items executed during Grimstroke combo (single-target items duplicate with Soulbind)"
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
		"Cancels attack backswing and pursues target when in range outside sweet-spot movement"
	)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider(
		"Orb Walk Safe Distance %",
		80,
		10,
		100,
		0,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)

	// Sleepers & SDK helpers
	private readonly sleeper = new TickSleeper()
	private readonly harassSleeper = new TickSleeper()
	private readonly illusionAttackSleeper = new TickSleeper()
	private readonly illusionBlockSleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	// State tracking
	private lockedTarget: Hero | undefined = undefined
	private currentPredictedStrokePos: Vector3 | undefined = undefined
	private currentBlockTargetPos: Vector3 | undefined = undefined
	private blockerZigzagSide = 1
	private lastBlockerTargetDir: Vector3 | undefined = undefined
	private lastSeenTargetPos: Vector3 | undefined = undefined
	private lastSeenTargetDir: Vector3 | undefined = undefined
	private lastSeenTargetSpeed = 300
	private lastSeenTargetTime = 0
	private wasTargetStationary = false

	// Illusion references for drawing
	private currentAttackerIllusion: Hero | undefined = undefined
	private currentBlockerIllusion: Hero | undefined = undefined

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("grimstroke_soulbind", [true, true, true, 0])
		defaultCombo.set("grimstroke_dark_portrait", [true, true, true, 1])
		defaultCombo.set("grimstroke_spirit_walk", [true, true, true, 2])
		defaultCombo.set("grimstroke_ink_creature", [true, true, true, 3])
		defaultCombo.set("grimstroke_dark_artistry", [true, true, true, 4])

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
		EventsSDK.on("GameStarted", this.onGameEnded.bind(this))
	}

	private onGameEnded(): void {
		this.sleeper.ResetTimer()
		this.harassSleeper.ResetTimer()
		this.illusionAttackSleeper.ResetTimer()
		this.illusionBlockSleeper.ResetTimer()
		this.lockedTarget = undefined
		this.currentPredictedStrokePos = undefined
		this.currentBlockTargetPos = undefined
		this.blockerZigzagSide = 1
		this.lastBlockerTargetDir = undefined
		this.lastSeenTargetPos = undefined
		this.lastSeenTargetDir = undefined
		this.lastSeenTargetSpeed = 300
		this.lastSeenTargetTime = 0
		this.wasTargetStationary = false
		this.currentAttackerIllusion = undefined
		this.currentBlockerIllusion = undefined
		this.pSDK.DestroyAll()
	}

	private get hasLocalHero(): boolean {
		return Boolean(
			LocalPlayer &&
				LocalPlayer.Hero &&
				LocalPlayer.Hero.IsValid &&
				LocalPlayer.Hero.Name === "npc_dota_hero_grimstroke"
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

	private isSoulbound(hero: Hero): boolean {
		return (
			hero.HasBuffByName("modifier_grimstroke_soulbind") ||
			hero.Buffs.some(b => b && b.IsValid && b.Name.includes("soulbind"))
		)
	}

	private OnDraw(): void {
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

		// 1. Draw Ink Swell 375 radius around bearer
		if (this.drawInkSwellRadius.value) {
			const inkUnits: Unit[] = []
			if (hero.HasBuffByName("modifier_grimstroke_spirit_walk_buff")) {
				inkUnits.push(hero)
			}
			for (const h of EntityManager.GetEntitiesByClass(Hero)) {
				if (
					h.IsValid &&
					h.IsAlive &&
					!h.IsEnemy(hero) &&
					h.HasBuffByName("modifier_grimstroke_spirit_walk_buff")
				) {
					if (!inkUnits.includes(h)) {
						inkUnits.push(h)
					}
				}
			}
			for (const bearer of inkUnits) {
				const bearerScreen = RendererSDK.WorldToScreen(bearer.Position)
				if (bearerScreen) {
					RendererSDK.OutlinedCircle(bearerScreen, new Vector2(375, 375), new Color(0, 210, 210, 200), 2)
				}
			}
		}

		// 2. Draw Stroke of Fate Predicted Vector & Intercept Point
		if (this.drawStrokePrediction.value && this.currentPredictedStrokePos && this.lockedTarget) {
			const heroScreen = RendererSDK.WorldToScreen(hero.Position)
			const targetScreen = RendererSDK.WorldToScreen(this.lockedTarget.Position)
			const predScreen = RendererSDK.WorldToScreen(this.currentPredictedStrokePos)
			if (heroScreen && predScreen) {
				RendererSDK.Line(heroScreen, predScreen, Color.Aqua.SetA(180), 2)
				RendererSDK.OutlinedCircle(predScreen, new Vector2(32, 32), Color.Aqua, 2)
				if (targetScreen) {
					RendererSDK.Line(targetScreen, predScreen, Color.Yellow.SetA(150), 1)
				}
			}
		}

		// 3. Draw Body Block Marker for Blocker Illusion
		if (this.drawBlockMarker.value && this.currentBlockTargetPos && this.currentBlockerIllusion) {
			const blockScreen = RendererSDK.WorldToScreen(this.currentBlockTargetPos)
			const illuScreen = RendererSDK.WorldToScreen(this.currentBlockerIllusion.Position)
			if (blockScreen) {
				RendererSDK.OutlinedCircle(blockScreen, new Vector2(26, 26), Color.Orange, 2)
				if (illuScreen) {
					RendererSDK.Line(illuScreen, blockScreen, Color.Orange.SetA(160), 1)
				}
			}
		}

		// 4. Draw Illusion Role Tags
		if (this.drawIllusionRoles.value) {
			if (
				this.currentAttackerIllusion &&
				this.currentAttackerIllusion.IsValid &&
				this.currentAttackerIllusion.IsAlive
			) {
				const screenPos = RendererSDK.WorldToScreen(
					this.currentAttackerIllusion.Position.Add(new Vector3(0, 0, 80))
				)
				if (screenPos) {
					RendererSDK.Text("DPS Attacker", screenPos, Color.Red, "Arial", 14)
				}
			}
			if (
				this.currentBlockerIllusion &&
				this.currentBlockerIllusion.IsValid &&
				this.currentBlockerIllusion.IsAlive
			) {
				const screenPos = RendererSDK.WorldToScreen(
					this.currentBlockerIllusion.Position.Add(new Vector3(0, 0, 80))
				)
				if (screenPos) {
					const label = this.wasTargetStationary ? "Blocker (Hit)" : "Body Blocker"
					RendererSDK.Text(label, screenPos, Color.Yellow, "Arial", 14)
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
			this.harassSleeper.ResetTimer()
			this.illusionAttackSleeper.ResetTimer()
			this.illusionBlockSleeper.ResetTimer()
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.lockedTarget = undefined
			this.currentPredictedStrokePos = undefined
			this.currentBlockTargetPos = undefined
			this.currentAttackerIllusion = undefined
			this.currentBlockerIllusion = undefined
			this.pSDK.DestroyByKey("grim_target_ring")
			return
		}

		// A. Independent Stroke of Fate Harass / Snipe Key handler
		this.handleStrokeHarassKey(hero)

		// B. Check if Combo Key is held
		// @ts-ignore
		const isComboActive = Boolean(this.comboKey.isPressed)

		if (!isComboActive) {
			this.lockedTarget = undefined
			this.currentPredictedStrokePos = undefined
			this.currentBlockTargetPos = undefined
			this.currentAttackerIllusion = undefined
			this.currentBlockerIllusion = undefined
			this.pSDK.DestroyByKey("grim_target_ring")
			return
		}

		if (hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// C. Target Acquisition & Locking
		let bestTarget: Hero | undefined = this.lockedTarget

		if (bestTarget && (!bestTarget.IsValid || !bestTarget.IsAlive)) {
			this.lockedTarget = undefined
			bestTarget = undefined
		}

		// Fog timeout: release lock after 1.5s
		if (bestTarget && !bestTarget.IsVisible && GameState.RawGameTime - this.lastSeenTargetTime > 1.5) {
			this.lockedTarget = undefined
			bestTarget = undefined
		}

		if (!bestTarget || !bestTarget.IsVisible) {
			const mousePos = InputManager.CursorOnWorld
			let minDist = Infinity
			let nearbyVisibleEnemy: Hero | undefined
			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && isRealHero(enemy)) {
					const dist = enemy.Position.Distance2D(mousePos)
					if (dist < this.comboRadius.value && dist < minDist) {
						minDist = dist
						nearbyVisibleEnemy = enemy
					}
				}
			}

			if (nearbyVisibleEnemy) {
				bestTarget = nearbyVisibleEnemy
				if (this.lockTargetEnabled.value) {
					this.lockedTarget = bestTarget
				}
			}
		}

		if (!bestTarget) {
			this.pSDK.DestroyByKey("grim_target_ring")
			this.currentPredictedStrokePos = undefined
			return
		}

		// Target indicator particle
		if (bestTarget.IsVisible) {
			this.pSDK.DrawCircle("grim_target_ring", bestTarget, 140, {
				Color: new Color(180, 0, 220, 220),
				Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
			})
		} else {
			this.pSDK.DestroyByKey("grim_target_ring")
		}

		// Update target position snapshot for fog prediction
		const now = GameState.RawGameTime
		if (bestTarget.IsVisible) {
			this.lastSeenTargetPos = bestTarget.Position.Clone()
			this.lastSeenTargetDir = bestTarget.Forward.Clone().SetZ(0).Normalize()
			this.lastSeenTargetSpeed = bestTarget.MoveSpeed > 50 ? bestTarget.MoveSpeed : 300
			this.lastSeenTargetTime = now
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// D. Dark Portrait Controllable Illusions Management
		let blockerIllusion: Hero | undefined
		if (this.autoControlIllusions.value) {
			const illusionRoles = this.manageDarkPortraitIllusions(hero, bestTarget)
			this.currentAttackerIllusion = illusionRoles.attacker
			this.currentBlockerIllusion = illusionRoles.blocker
			blockerIllusion = illusionRoles.blocker
		} else {
			this.currentAttackerIllusion = undefined
			this.currentBlockerIllusion = undefined
		}

		// E. Ink Swell Sweet-Spot Movement Check:
		// If Grimstroke himself carries Ink Swell, ensure target stays within 375 explosion radius!
		const isInkSwellOnMe = hero.HasBuffByName("modifier_grimstroke_spirit_walk_buff")
		const distToTarget = hero.Distance2D(bestTarget)
		const sweetMin = this.inkSwellSweetSpotMin.value
		const sweetMax = this.inkSwellSweetSpotMax.value

		// If Ink Swell is active on Grimstroke and target is drifting away (> sweetMax),
		// sprint towards enemy to maintain collision proximity before explosion!
		if (isInkSwellOnMe && distToTarget > sweetMax) {
			if (!this.sleeper.Sleeping) {
				const approachPos = bestTarget.IsMoving ? bestTarget.InFront(60) : bestTarget.Position.Clone()
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
					issuers: [hero],
					position: approachPos,
					queue: false,
					showEffects: false,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 60)
			}
			// Grimstroke can still cast spells during sweet spot approach if ready!
		}

		if (this.sleeper.Sleeping) {
			return
		}

		// F. Execute Offensive & Soulbind Items
		if (this.executeItems(hero, bestTarget, isTargetImmune)) {
			return
		}

		// G. Execute Dynamic Skill Sequence
		if (this.executeSpellSequence(hero, bestTarget, isTargetImmune, blockerIllusion)) {
			return
		}

		// H. Smart Orb Walk (Normal Attacks Outside Blade Fury / Sweet Spot Rush)
		const isInSweetSpot = distToTarget <= sweetMax && distToTarget >= sweetMin
		if (this.smartOrbWalkEnabled.value && (!isInkSwellOnMe || isInSweetSpot)) {
			executeOrbwalk(hero, bestTarget, this.sleeper, {
				enabled: this.smartOrbWalkEnabled.value,
				safeDistancePct: this.smartOrbWalkDistancePct.value,
				stopToCancel: false
			})
		}
	}

	/**
	 * Dedicated Harass / Snipe Key Handler for Stroke of Fate.
	 * Can be triggered independently without executing full combo.
	 */
	private handleStrokeHarassKey(hero: Hero): void {
		if (!this.strokeHarassEnabled.value || this.harassSleeper.Sleeping) {
			return
		}

		// @ts-ignore
		if (!this.strokeHarassKey.isPressed) {
			return
		}

		if (hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		const stroke = hero.GetAbilityByName("grimstroke_dark_artistry")
		if (!stroke || !stroke.IsValid || stroke.Level === 0 || stroke.Cooldown > 0.1 || hero.Mana < stroke.ManaCost) {
			return
		}

		const mousePos = InputManager.CursorOnWorld
		let bestEnemy: Hero | undefined
		let minDist = Infinity
		const maxCastDist = (stroke.CastRange > 0 ? stroke.CastRange : 1400) + 250

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && isRealHero(enemy)) {
				const cursorDist = enemy.Position.Distance2D(mousePos)
				const heroDist = hero.Distance2D(enemy)
				if (heroDist <= maxCastDist && cursorDist < minDist) {
					minDist = cursorDist
					bestEnemy = enemy
				}
			}
		}

		if (!bestEnemy) {
			return
		}

		this.ensureStrokeAltCastState(hero, stroke, bestEnemy)
		const predictedPos = this.predictStrokePosition(hero, bestEnemy, stroke)
		this.currentPredictedStrokePos = predictedPos.Clone()

		claimOrder()
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
			issuers: [hero],
			position: predictedPos,
			ability: stroke.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})

		const delay = GameState.InputLag * 1000 + stroke.CastPoint * 1000 + 100
		this.harassSleeper.Sleep(delay)
		this.sleeper.Sleep(delay)
	}

	/**
	 * Configures Stroke of Fate Alt-Cast mode.
	 * Alt-Cast fires a straight linear projectile (Puck Orb style).
	 */
	private ensureStrokeAltCastState(hero: Hero, ability: any, target: Hero): void {
		const mode = this.strokeMode.SelectedID
		let wantAltCast = true

		if (mode === 0) {
			// Auto / Alt-Cast (Straight Line)
			wantAltCast = true
		} else if (mode === 1) {
			// Normal Cast (Curved)
			wantAltCast = false
		} else if (mode === 2) {
			// Conditional: straight line if moving or > 500 distance, curved if stationary close
			const dist = hero.Distance2D(target)
			const isMoving = target.IsMoving && target.MoveSpeed > 60
			wantAltCast = isMoving || dist > 500
		}

		const currentAlt = Boolean(ability.AltCastState)
		if (wantAltCast !== currentAlt) {
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

	/**
	 * Calculates lead intercept position for Stroke of Fate straight linear projectile.
	 * Projectile Speed: 2000 units/second.
	 * Cast Point: 0.6 seconds.
	 */
	private predictStrokePosition(hero: Hero, target: Hero, ability: any): Vector3 {
		const castPoint = ability.CastPoint || 0.6
		const projSpeed = 2000
		const latency = GameState.InputLag
		const currentDist = hero.Distance2D(target)
		const travelTime = castPoint + latency + currentDist / projSpeed
		const maxRange = (ability.CastRange > 0 ? ability.CastRange : 1400) + 100

		let predicted = target.Position.Clone()
		if (target.IsMoving && target.MoveSpeed > 50 && !target.IsStunned && !target.IsRooted) {
			const targetDir = target.Forward.Clone().SetZ(0).Normalize()
			const moveSpeed = target.MoveSpeed
			const travelOffset = targetDir.MultiplyScalar(moveSpeed * travelTime)
			predicted = target.Position.Add(travelOffset)
		}

		// Clamp along direction from hero if beyond max range
		const toPredicted = predicted.Subtract(hero.Position)
		toPredicted.SetZ(0)
		const distToPred = toPredicted.Length2D
		if (distToPred > maxRange) {
			predicted = hero.Position.Add(toPredicted.Normalize().MultiplyScalar(maxRange))
		}

		return predicted
	}

	/**
	 * Retrieves all active Dark Portrait illusions under player control.
	 * Dark Portrait illusions replicate enemy heroes with +30% MS, 150% damage, and spell immunity.
	 */
	private getDarkPortraitIllusions(hero: Hero): Hero[] {
		const illusions: Hero[] = []
		const myPlayerId = LocalPlayer?.PlayerID ?? -1

		for (const h of EntityManager.GetEntitiesByClass(Hero)) {
			if (!h || !h.IsValid || !h.IsAlive || !h.IsIllusion || h.IsEnemy(hero)) {
				continue
			}
			if (h.PlayerID !== myPlayerId && !h.IsControllable) {
				continue
			}
			// Filter out Grimstroke's own illusions (e.g. Manta Style)
			if (h.Name === "npc_dota_hero_grimstroke") {
				continue
			}

			illusions.push(h)
		}

		return illusions
	}

	/**
	 * Coordinates Dark Portrait Illusions:
	 * - 1 Illusion: Prioritizes ATTACK (hit) as requested by user.
	 * - 2 Illusions: Illusion with highest DPS continuously attacks, secondary executes pure body block!
	 */
	private manageDarkPortraitIllusions(hero: Hero, target: Hero): { attacker?: Hero; blocker?: Hero } {
		const illusions = this.getDarkPortraitIllusions(hero)
		if (illusions.length === 0) {
			this.currentBlockTargetPos = undefined
			return {}
		}

		// Single illusion: focus hit
		if (illusions.length === 1) {
			const singleIllu = illusions[0]
			this.issueIllusionAttack(singleIllu, target)
			this.currentBlockTargetPos = undefined
			return { attacker: singleIllu }
		}

		// 2+ illusions: Sort by estimated DPS (Attacker = highest DPS, Blocker = secondary)
		const getIllusionDPS = (illu: Hero): number => {
			const minDmg = illu.AttackDamageMin || illu.BaseDamageMin || 50
			const maxDmg = illu.AttackDamageMax || illu.BaseDamageMax || minDmg
			const avgDmg = (minDmg + maxDmg) / 2
			const bat = illu.NetworkBaseAttackTime > 0 ? illu.NetworkBaseAttackTime : 1.7
			const agi = illu.TotalAgility > 0 ? illu.TotalAgility : 20
			const approxAps = (100 + agi) / (100 * bat)
			return avgDmg * approxAps
		}
		illusions.sort((a, b) => getIllusionDPS(b) - getIllusionDPS(a))

		const attacker = illusions[0]
		const blocker = illusions[1]

		this.issueIllusionAttack(attacker, target)
		this.executeIllusionBodyBlock(blocker, target)

		return { attacker, blocker }
	}

	private issueIllusionAttack(illusion: Hero, target: Hero): void {
		if (this.illusionAttackSleeper.Sleeping) {
			return
		}

		claimOrder()
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
			issuers: [illusion],
			target: target.Index,
			queue: false,
			showEffects: false,
			isPlayerInput: false
		})

		this.illusionAttackSleeper.Sleep(GameState.InputLag * 1000 + 150)
	}

	/**
	 * Guaranteed forward vector along target heading clamped within maxAngleDeg.
	 */
	private getForwardTarget(
		unitPos: Vector3,
		targetDir: Vector3,
		targetPerp: Vector3,
		stepFwd: number,
		desiredLat: number,
		maxAngleDeg = 24
	): Vector3 {
		const fwd = Math.max(stepFwd, 10)
		const maxLat = fwd * Math.tan((maxAngleDeg * Math.PI) / 180)
		const lat = Math.max(-maxLat, Math.min(maxLat, desiredLat))
		return unitPos.Add(targetDir.MultiplyScalar(fwd)).Add(targetPerp.MultiplyScalar(lat))
	}

	private issueIllusionMove(illusion: Hero, position: Vector3, minSleepMs = 60): void {
		claimOrder()
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_MOVE_TO_POSITION,
			issuers: [illusion],
			position,
			queue: false,
			showEffects: false,
			isPlayerInput: false
		})

		this.illusionBlockSleeper.Sleep(GameState.InputLag * 1000 + minSleepMs)
	}

	/**
	 * Pure-movement body blocking algorithm for Blocker Illusion.
	 * STRICTLY ZERO ATTACK ORDERS, ZERO ORDER_STOP!
	 * Adopts the collision hull obstruction mathematics perfected in Juggernaut body block.
	 */
	private executeIllusionBodyBlock(illusion: Hero, target: Hero): void {
		const now = GameState.RawGameTime

		// Fog prediction for illusion body blocking
		if (!target.IsVisible) {
			const fogDuration = now - this.lastSeenTargetTime
			if (fogDuration <= 1.5 && this.lastSeenTargetPos && this.lastSeenTargetDir) {
				const travelDist = Math.min(360, this.lastSeenTargetSpeed * fogDuration + 60)
				const predictedFogPos = this.lastSeenTargetPos.Add(this.lastSeenTargetDir.MultiplyScalar(travelDist))
				this.currentBlockTargetPos = predictedFogPos.Clone()
				this.issueIllusionMove(illusion, predictedFogPos, 55)
				return
			}
			this.currentBlockTargetPos = undefined
			return
		}

		const targetIsMoving = target.IsMoving && target.MoveSpeed > 50 && !target.IsStunned && !target.IsRooted

		// JIKA MUSUH DIAM / STUNNED / ROOTED:
		// Ilusi B (Blocker) ikut memukul (hit) musuh!
		if (!targetIsMoving) {
			this.wasTargetStationary = true
			this.lastBlockerTargetDir = undefined
			this.currentBlockTargetPos = undefined

			if (this.illusionBlockSleeper.Sleeping) {
				return
			}

			claimOrder()
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_ATTACK_TARGET,
				issuers: [illusion],
				target: target.Index,
				queue: false,
				showEffects: false,
				isPlayerInput: false
			})

			this.illusionBlockSleeper.Sleep(GameState.InputLag * 1000 + 150)
			return
		}

		// Jika musuh sebelumnya diam lalu baru mulai bergerak:
		// Reset timer seketika agar Ilusi B langsung menyalip dan mem-block tanpa delay!
		if (this.wasTargetStationary) {
			this.wasTargetStationary = false
			this.illusionBlockSleeper.ResetTimer()
		}

		// 1. Resolve Target Movement Direction
		let rawTargetDir = target.Forward.Clone().SetZ(0)
		rawTargetDir =
			rawTargetDir.Length2D < 0.05 ? illusion.Forward.Clone().SetZ(0).Normalize() : rawTargetDir.Normalize()

		// 2. Instant Juke / Gocek Detection
		if (this.lastBlockerTargetDir) {
			const turnDot = rawTargetDir.Dot(this.lastBlockerTargetDir)
			if (turnDot < 0.5) {
				this.illusionBlockSleeper.ResetTimer()
			}
		}
		this.lastBlockerTargetDir = rawTargetDir.Clone()

		if (this.illusionBlockSleeper.Sleeping) {
			return
		}

		const targetDir = this.lastBlockerTargetDir
		const targetPerp = new Vector3(-targetDir.y, targetDir.x, 0)

		// 3. Lead Delta along target's heading
		const illuProg = illusion.Position.x * targetDir.x + illusion.Position.y * targetDir.y
		const targetProg = target.Position.x * targetDir.x + target.Position.y * targetDir.y
		const leadDelta = illuProg - targetProg

		// Lateral offset crosswise to target's heading
		const toIllu = illusion.Position.Subtract(target.Position)
		toIllu.SetZ(0)
		const latDiff = toIllu.x * targetPerp.x + toIllu.y * targetPerp.y

		// SCENARIO 1: OVERTAKE (leadDelta < 32)
		// Dark Portrait illusion has +30% MS, sprints alongside with lateral clearance
		if (leadDelta < 32) {
			const flankSide = latDiff >= 0 ? 1 : -1
			const desiredLatOffset = flankSide * 42 - latDiff
			const overtakePos = this.getForwardTarget(
				illusion.Position,
				targetDir,
				targetPerp,
				50,
				desiredLatOffset,
				25
			)

			this.currentBlockTargetPos = overtakePos.Clone()
			this.issueIllusionMove(illusion, overtakePos, 55)
			return
		}

		// SCENARIO 2: CUTTING IN (leadDelta >= 32 and |latDiff| > 18)
		if (Math.abs(latDiff) > 18) {
			const inwardPull = -latDiff * 0.7
			const cutInPos = this.getForwardTarget(illusion.Position, targetDir, targetPerp, 28, inwardPull, 24)

			this.currentBlockTargetPos = cutInPos.Clone()
			this.issueIllusionMove(illusion, cutInPos, 50)
			return
		}

		// SCENARIO 3: TOO FAR AHEAD (leadDelta > 48 and |latDiff| <= 18)
		// Crawl forward 4 units so enemy catches up directly into illusion's rear hull
		if (leadDelta > 48) {
			const crawlPos = this.getForwardTarget(illusion.Position, targetDir, targetPerp, 4, -latDiff * 0.2, 10)
			this.currentBlockTargetPos = crawlPos.Clone()
			this.issueIllusionMove(illusion, crawlPos, 70)
			return
		}

		// SCENARIO 4: ACTIVE BODY BLOCKING (32 <= leadDelta <= 48 and |latDiff| <= 18)
		// Continuous micro-movement directly in front of enemy nose with lateral weave
		this.blockerZigzagSide = -this.blockerZigzagSide
		const lateralWeave = this.blockerZigzagSide * 8 - latDiff * 0.4
		const stepFwd = Math.max(8, Math.min(14, 46 - leadDelta + 6))
		const stepPos = this.getForwardTarget(illusion.Position, targetDir, targetPerp, stepFwd, lateralWeave, 18)

		this.currentBlockTargetPos = stepPos.Clone()
		this.issueIllusionMove(illusion, stepPos, 60)
	}

	/**
	 * Selects optimal target for Ink Swell based on hierarchical proximity:
	 * 1. Dark Portrait Blocker Illusion (physically locked onto target)
	 * 2. Closer Allied Hero/Unit (closer than Grimstroke and <= 400 range of enemy)
	 * 3. Grimstroke himself
	 */
	private resolveInkSwellTarget(hero: Hero, enemy: Hero, blockerIllusion?: Hero): Unit {
		if (this.inkSwellTargetingMode.SelectedID === 1) {
			return hero
		}

		const inkSwell = hero.GetAbilityByName("grimstroke_spirit_walk")
		const castRange = (inkSwell?.CastRange || 700) + 150

		// Priority 1: Blocker illusion
		if (blockerIllusion && blockerIllusion.IsValid && blockerIllusion.IsAlive) {
			if (hero.Distance2D(blockerIllusion) <= castRange) {
				return blockerIllusion
			}
		}

		// Priority 2: Allied heroes closer to enemy than Grimstroke and within 400 of enemy
		const heroDistToEnemy = hero.Distance2D(enemy)
		let bestAlly: Hero | undefined
		let bestDist = heroDistToEnemy

		for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
			if (ally.IsValid && ally.IsAlive && !ally.IsEnemy(hero) && ally.Index !== hero.Index) {
				const distToEnemy = ally.Distance2D(enemy)
				const distToGrim = hero.Distance2D(ally)
				if (distToEnemy <= 400 && distToEnemy < bestDist && distToGrim <= castRange) {
					bestDist = distToEnemy
					bestAlly = ally
				}
			}
		}

		if (bestAlly) {
			return bestAlly
		}

		// Priority 3: Grimstroke himself
		return hero
	}

	/**
	 * Executes skills according to dynamic selector order.
	 */
	private executeSpellSequence(hero: Hero, target: Hero, isTargetImmune: boolean, blockerIllusion?: Hero): boolean {
		if (!this.comboSequenceGrid) {
			return false
		}

		for (const actionName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(actionName)) {
				continue
			}

			// 1. SOULBIND (R)
			if (actionName === "grimstroke_soulbind") {
				if (isTargetImmune) {
					continue
				}
				const soulbind = hero.GetAbilityByName("grimstroke_soulbind")
				if (
					soulbind &&
					soulbind.IsValid &&
					soulbind.Level > 0 &&
					soulbind.Cooldown <= 0.1 &&
					hero.Mana >= soulbind.ManaCost &&
					!this.isSoulbound(target)
				) {
					const castRange = (soulbind.CastRange > 0 ? soulbind.CastRange : 800) + 150
					if (hero.Distance2D(target) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: target.Index,
							ability: soulbind.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + soulbind.CastPoint * 1000 + 150)
						return true
					}
				}
			}

			// 2. DARK PORTRAIT (Aghanim's Scepter D)
			else if (actionName === "grimstroke_dark_portrait") {
				if (isTargetImmune) {
					continue
				}
				const portrait = hero.GetAbilityByName("grimstroke_dark_portrait")
				if (
					portrait &&
					portrait.IsValid &&
					portrait.Level > 0 &&
					portrait.Cooldown <= 0.1 &&
					hero.Mana >= portrait.ManaCost &&
					!portrait.IsHidden
				) {
					const castRange = (portrait.CastRange > 0 ? portrait.CastRange : 800) + 150
					if (hero.Distance2D(target) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: target.Index,
							ability: portrait.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + portrait.CastPoint * 1000 + 150)
						return true
					}
				}
			}

			// 3. INK SWELL (E)
			else if (actionName === "grimstroke_spirit_walk") {
				const inkSwell = hero.GetAbilityByName("grimstroke_spirit_walk")
				if (
					inkSwell &&
					inkSwell.IsValid &&
					inkSwell.Level > 0 &&
					inkSwell.Cooldown <= 0.1 &&
					hero.Mana >= inkSwell.ManaCost
				) {
					const chosenTarget = this.resolveInkSwellTarget(hero, target, blockerIllusion)
					const castRange = (inkSwell.CastRange > 0 ? inkSwell.CastRange : 700) + 150

					if (hero.Distance2D(chosenTarget) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: chosenTarget.Index,
							ability: inkSwell.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + inkSwell.CastPoint * 1000 + 120)
						return true
					}
				}
			}

			// 4. PHANTOM'S EMBRACE (W)
			else if (actionName === "grimstroke_ink_creature") {
				if (isTargetImmune) {
					continue
				}
				const embrace = hero.GetAbilityByName("grimstroke_ink_creature")
				if (
					embrace &&
					embrace.IsValid &&
					embrace.Level > 0 &&
					embrace.Cooldown <= 0.1 &&
					hero.Mana >= embrace.ManaCost
				) {
					const castRange = (embrace.CastRange > 0 ? embrace.CastRange : 900) + 150
					if (hero.Distance2D(target) <= castRange) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: target.Index,
							ability: embrace.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + embrace.CastPoint * 1000 + 120)
						return true
					}
				}
			}

			// 5. STROKE OF FATE (Q)
			else if (actionName === "grimstroke_dark_artistry") {
				const stroke = hero.GetAbilityByName("grimstroke_dark_artistry")
				if (
					stroke &&
					stroke.IsValid &&
					stroke.Level > 0 &&
					stroke.Cooldown <= 0.1 &&
					hero.Mana >= stroke.ManaCost
				) {
					const castRange = (stroke.CastRange > 0 ? stroke.CastRange : 1400) + 150
					if (hero.Distance2D(target) <= castRange) {
						this.ensureStrokeAltCastState(hero, stroke, target)
						const predictedPos = this.predictStrokePosition(hero, target, stroke)
						this.currentPredictedStrokePos = predictedPos.Clone()

						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: predictedPos,
							ability: stroke.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + stroke.CastPoint * 1000 + 120)
						return true
					}
				}
			}
		}

		return false
	}

	/**
	 * Offense & Utility Items Execution (Duplicated onto bound partner when Soulbind is active).
	 */
	private executeItems(hero: Hero, target: Hero, isTargetImmune: boolean): boolean {
		const dist = hero.Distance2D(target)

		// 1. BLINK DAGGER
		if (this.itemsSelector.IsEnabled("item_blink") && this.blinkMode.SelectedID !== 2) {
			if (dist > 500) {
				const blink =
					this.getItem(hero, "item_blink") ||
					this.getItem(hero, "item_arcane_blink") ||
					this.getItem(hero, "item_swift_blink") ||
					this.getItem(hero, "item_overwhelming_blink")

				if (blink && blink.Cooldown <= 0.1) {
					const blinkRange = blink.CastRange > 0 ? blink.CastRange : 1200
					let blinkPos = target.Position.Clone()

					if (this.blinkMode.SelectedID === 1 && dist > blinkRange) {
						const dir = target.Position.Subtract(hero.Position).Normalize()
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

		// 2. BLACK KING BAR
		if (this.itemsSelector.IsEnabled("item_black_king_bar") && !hero.IsMuted && !hero.IsDebuffImmune) {
			const bkb = this.getItem(hero, "item_black_king_bar")
			if (bkb && bkb.Cooldown <= 0.1 && dist <= 750) {
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

		// 3. SCYTHE OF VYSE (Hex - duplicates with Soulbind)
		if (this.itemsSelector.IsEnabled("item_sheepstick") && !hero.IsMuted && !isTargetImmune) {
			const hex = this.getItem(hero, "item_sheepstick")
			if (hex && hex.Cooldown <= 0.1 && hero.Mana >= hex.ManaCost && dist <= (hex.CastRange || 800) + 100) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: hex.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 4. BLOODTHORN / ORCHID (duplicates with Soulbind)
		if (
			(this.itemsSelector.IsEnabled("item_bloodthorn") || this.itemsSelector.IsEnabled("item_orchid")) &&
			!hero.IsMuted &&
			!isTargetImmune
		) {
			const silence = this.getItem(hero, "item_bloodthorn") || this.getItem(hero, "item_orchid")
			if (
				silence &&
				silence.Cooldown <= 0.1 &&
				hero.Mana >= silence.ManaCost &&
				dist <= (silence.CastRange || 800) + 100
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: silence.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 5. ETHEREAL BLADE (Magic Burst & Slow - duplicates with Soulbind)
		if (this.itemsSelector.IsEnabled("item_ethereal_blade") && !hero.IsMuted && !isTargetImmune) {
			const eblade = this.getItem(hero, "item_ethereal_blade")
			if (
				eblade &&
				eblade.Cooldown <= 0.1 &&
				hero.Mana >= eblade.ManaCost &&
				dist <= (eblade.CastRange || 800) + 100 &&
				!target.HasBuffByName("modifier_item_ethereal_blade_ethereal")
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
				return true
			}
		}

		// 6. DAGON (Levels 1-5 - duplicates with Soulbind)
		if (this.itemsSelector.IsEnabled("item_dagon") && !hero.IsMuted && !isTargetImmune) {
			const dagon = this.getItem(hero, "item_dagon")
			if (
				dagon &&
				dagon.Cooldown <= 0.1 &&
				hero.Mana >= dagon.ManaCost &&
				dist <= (dagon.CastRange || 700) + 100
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: dagon.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 7. NULLIFIER (duplicates with Soulbind)
		if (this.itemsSelector.IsEnabled("item_nullifier") && !hero.IsMuted && !isTargetImmune) {
			const nullifier = this.getItem(hero, "item_nullifier")
			if (
				nullifier &&
				nullifier.Cooldown <= 0.1 &&
				hero.Mana >= nullifier.ManaCost &&
				dist <= (nullifier.CastRange || 800) + 100
			) {
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
				return true
			}
		}

		// 8. ROD OF ATOS / GLEIPNIR (Root - duplicates with Soulbind)
		if (
			(this.itemsSelector.IsEnabled("item_rod_of_atos") || this.itemsSelector.IsEnabled("item_gungir")) &&
			!hero.IsMuted &&
			!isTargetImmune
		) {
			const atos = this.getItem(hero, "item_rod_of_atos")
			if (atos && atos.Cooldown <= 0.1 && hero.Mana >= atos.ManaCost && dist <= (atos.CastRange || 1100) + 100) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: atos.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}

			const gleipnir = this.getItem(hero, "item_gungir")
			if (
				gleipnir &&
				gleipnir.Cooldown <= 0.1 &&
				hero.Mana >= gleipnir.ManaCost &&
				dist <= (gleipnir.CastRange || 1100) + 100
			) {
				const castPos = target.IsMoving ? target.InFront(50) : target.Position.Clone()
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: castPos,
					ability: gleipnir.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 9. HEAVEN'S HALBERD (Disarm - duplicates with Soulbind)
		if (this.itemsSelector.IsEnabled("item_heavens_halberd") && !hero.IsMuted && !isTargetImmune) {
			const halberd = this.getItem(hero, "item_heavens_halberd")
			if (
				halberd &&
				halberd.Cooldown <= 0.1 &&
				hero.Mana >= halberd.ManaCost &&
				dist <= (halberd.CastRange || 650) + 100
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: target.Index,
					ability: halberd.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 10. ABYSSAL BLADE (Stun - duplicates with Soulbind)
		if (this.itemsSelector.IsEnabled("item_abyssal_blade") && !hero.IsMuted && !isTargetImmune) {
			const abyssal = this.getItem(hero, "item_abyssal_blade")
			if (
				abyssal &&
				abyssal.Cooldown <= 0.1 &&
				hero.Mana >= abyssal.ManaCost &&
				dist <= (abyssal.CastRange || 600) + 100
			) {
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
				return true
			}
		}

		// 11. SHIVA'S GUARD
		if (this.itemsSelector.IsEnabled("item_shivas_guard") && !hero.IsMuted && dist <= 900) {
			const shiva = this.getItem(hero, "item_shivas_guard")
			if (shiva && shiva.Cooldown <= 0.1 && hero.Mana >= shiva.ManaCost) {
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

		// 12. VEIL OF DISCORD
		if (this.itemsSelector.IsEnabled("item_veil_of_discord") && !hero.IsMuted && !isTargetImmune) {
			const veil = this.getItem(hero, "item_veil_of_discord")
			if (veil && veil.Cooldown <= 0.1 && hero.Mana >= veil.ManaCost && dist <= 900) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: target.Position,
					ability: veil.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 13. SPIRIT VESSEL / URN (duplicates with Soulbind)
		if (
			(this.itemsSelector.IsEnabled("item_spirit_vessel") ||
				this.itemsSelector.IsEnabled("item_urn_of_shadows")) &&
			!hero.IsMuted &&
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
				return true
			}
		}

		// 14. DIFFUSAL BLADE / DISPERSER (duplicates with Soulbind)
		if (
			(this.itemsSelector.IsEnabled("item_diffusal_blade") || this.itemsSelector.IsEnabled("item_disperser")) &&
			!hero.IsMuted &&
			!isTargetImmune &&
			dist <= 650
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
				return true
			}
		}

		return false
	}
})()
