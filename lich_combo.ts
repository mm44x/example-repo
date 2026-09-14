import {
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
	Vector2
} from "github.com/octarine-public/wrapper/index"

import { claimOrder, isRealHero } from "./coordination"
import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = [
	"lich_ice_spire",
	"lich_chain_frost",
	"lich_frost_nova",
	"lich_frost_shield",
	"lich_sinister_gaze"
]

const COMBO_ITEMS = [
	"item_blink",
	"item_arcane_blink",
	"item_swift_blink",
	"item_overwhelming_blink",
	"item_sheepstick",
	"item_glimmer_cape",
	"item_bloodthorn",
	"item_orchid",
	"item_ethereal_blade",
	"item_dagon",
	"item_rod_of_atos",
	"item_gungir",
	"item_shivas_guard",
	"item_veil_of_discord",
	"item_spirit_vessel",
	"item_urn_of_shadows",
	"item_black_king_bar",
	"item_refresher"
]

new (class LichCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Lich Combo", "panorama/images/heroes/icons/npc_dota_hero_lich_png.vtex_c", "", 0)

	// Combo Controls
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute full Lich combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 1000, 400, 1600, 25)
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"Locks onto a single target hero when holding the combo key"
	)

	// Dynamic Skill Sequence Selector
	private comboSequenceGrid: any

	// Sinister Gaze (Skill 3) Settings
	private readonly gazeNode = this.entry.AddNode("Sinister Gaze (E)")
	private readonly allowSpellsDuringGaze = this.gazeNode.AddToggle(
		"Cast Spells & Items During Gaze (Requires Scepter)",
		true,
		"Allows casting abilities and items during Sinister Gaze (Only active when Lich possesses Aghanim's Scepter)"
	)
	private readonly protectGazeChannel = this.gazeNode.AddToggle(
		"Strict Gaze Channel Protection",
		true,
		"Blocks accidental move and attack commands during Gaze channel while permitting spells and items"
	)
	private readonly autoInterruptGaze = this.gazeNode.AddToggle(
		"Auto Interrupt Enemy Channeling",
		true,
		"Automatically casts Sinister Gaze to cancel enemy channeling spells (TP, Black Hole, Freezing Field, etc.)"
	)
	private readonly autoInterruptRange = this.gazeNode.AddSlider(
		"Auto Interrupt Max Range",
		600,
		400,
		900,
		25,
		"Maximum range to trigger background Sinister Gaze interrupt"
	)

	// Ice Spire (Shard) & Chain Frost Settings
	private readonly spireNode = this.entry.AddNode("Ice Spire & Chain Frost")
	private readonly requireBounceTarget = this.spireNode.AddToggle(
		"Require Bounce Target for Chain Frost",
		true,
		"Only casts Chain Frost if >= 2 enemies/creeps are nearby, or if Ice Spire is planted/ready for bouncing"
	)
	private readonly autoSpireBeforeChain = this.spireNode.AddToggle(
		"Spawn Ice Spire Before Chain Frost",
		true,
		"Drops Ice Spire near target before throwing Chain Frost to ensure maximum bounce damage on solo kills"
	)
	private readonly spirePlacementOffset = this.spireNode.AddSlider(
		"Ice Spire Spawn Offset",
		150,
		50,
		350,
		25,
		"Distance to offset Ice Spire between Lich and target for optimal bounce frequency and Gaze attraction"
	)

	// Frost Shield (W) Settings
	private readonly shieldNode = this.entry.AddNode("Frost Shield (W)")
	private readonly shieldTargetMode = this.shieldNode.AddDropdown(
		"Frost Shield Target Mode",
		["Smart (Closer Ally > Self)", "Always Self", "Disabled in Combo"],
		0,
		"Who to target with Frost Shield during combo"
	)
	private readonly autoSaveAllyShield = this.shieldNode.AddToggle(
		"Auto Frost Shield Ally Save",
		true,
		"Cast Frost Shield on allies or self when taking physical damage under HP threshold"
	)
	private readonly autoSaveAllyHpPct = this.shieldNode.AddSlider(
		"Ally Save HP Threshold %",
		50,
		20,
		80,
		5,
		"HP percentage threshold to trigger defensive Frost Shield"
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
			["item_glimmer_cape", true],
			["item_bloodthorn", true],
			["item_orchid", true],
			["item_ethereal_blade", true],
			["item_dagon", true],
			["item_rod_of_atos", true],
			["item_gungir", true],
			["item_shivas_guard", true],
			["item_veil_of_discord", true],
			["item_spirit_vessel", true],
			["item_urn_of_shadows", true],
			["item_black_king_bar", true],
			["item_refresher", true]
		]),
		"Enable or disable offensive and defensive items for Lich combo"
	)
	private readonly blinkMode = this.itemsNode.AddDropdown(
		"Blink Dagger Usage",
		["Blink In Range (550)", "Blink Directly To Target", "Disabled"],
		0,
		"How Blink Dagger initiates on the target"
	)

	// Smart Orb Walk
	private readonly smartOrbWalkEnabled = this.entry.AddToggle(
		"Enable Smart Orb Walk",
		true,
		"Cancels attack backswing and pursues target outside of Sinister Gaze channel"
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
	private readonly saveSleeper = new TickSleeper()
	private readonly interruptSleeper = new TickSleeper()
	private readonly pSDK = new ParticlesSDK()

	// State tracking
	private lockedTarget: Hero | undefined = undefined

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("lich_ice_spire", [true, true, true, 0])
		defaultCombo.set("lich_chain_frost", [true, true, true, 1])
		defaultCombo.set("lich_frost_nova", [true, true, true, 2])
		defaultCombo.set("lich_frost_shield", [true, true, true, 3])
		defaultCombo.set("lich_sinister_gaze", [true, true, true, 4])

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
		EventsSDK.on("PrepareUnitOrders", this.onPrepareUnitOrders.bind(this))
	}

	private onGameEnded(): void {
		this.sleeper.ResetTimer()
		this.saveSleeper.ResetTimer()
		this.interruptSleeper.ResetTimer()
		this.lockedTarget = undefined
		this.pSDK.DestroyAll()
	}

	private get hasLocalHero(): boolean {
		return Boolean(
			LocalPlayer &&
				LocalPlayer.Hero &&
				LocalPlayer.Hero.IsValid &&
				LocalPlayer.Hero.Name === "npc_dota_hero_lich"
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
	 * Checks if Lich is currently channeling Sinister Gaze.
	 */
	private isGazing(hero: Hero): boolean {
		const gaze = hero.GetAbilityByName("lich_sinister_gaze")
		return Boolean(
			hero.HasBuffByName("modifier_lich_sinister_gaze_self") ||
				(gaze && gaze.IsValid && (gaze.IsChanneling || gaze.IsInAbilityPhase))
		)
	}

	/**
	 * Counts potential bounce targets within radius around a target for Chain Frost.
	 */
	private countChainFrostBounceTargets(hero: Hero, target: Hero, bounceRadius = 600): number {
		let count = 1 // target itself counts as 1

		// Check other enemy heroes
		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (
				enemy.IsValid &&
				enemy.IsAlive &&
				enemy.IsVisible &&
				enemy.IsEnemy(hero) &&
				enemy !== target &&
				!enemy.IsIllusion &&
				target.Distance2D(enemy) <= bounceRadius
			) {
				count++
			}
		}

		// Check creeps / neutrals / summons
		for (const creep of EntityManager.GetEntitiesByClass(Creep)) {
			if (
				creep.IsValid &&
				creep.IsAlive &&
				creep.IsVisible &&
				!creep.IsInvulnerable &&
				target.Distance2D(creep) <= bounceRadius
			) {
				count++
			}
		}

		// Check if an Ice Spire is planted nearby
		for (const unit of EntityManager.GetEntitiesByClass(Unit)) {
			if (
				unit.IsValid &&
				unit.IsAlive &&
				unit.Name.includes("ice_spire") &&
				target.Distance2D(unit) <= bounceRadius
			) {
				count += 5 // Spire provides unlimited bounce capacity
			}
		}

		return count
	}

	/**
	 * Selects the optimal target for Frost Shield in combo.
	 */
	private getBestFrostShieldTarget(hero: Hero, bestTarget: Hero): Unit | undefined {
		if (this.shieldTargetMode.SelectedID === 2) {
			return undefined
		}

		const shield = hero.GetAbilityByName("lich_frost_shield")
		if (!shield || !shield.IsValid || shield.Level <= 0 || shield.Cooldown > 0.1 || hero.Mana < shield.ManaCost) {
			return undefined
		}

		const castRange = shield.CastRange > 0 ? shield.CastRange : 750

		// Mode 0: Smart Hierarchy (Closer Ally > Self)
		if (this.shieldTargetMode.SelectedID === 0) {
			let closestAlly: Hero | undefined
			let minAllyDist = hero.Distance2D(bestTarget)

			for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
				if (
					ally.IsValid &&
					ally.IsAlive &&
					!ally.IsEnemy(hero) &&
					ally !== hero &&
					!ally.IsIllusion &&
					hero.Distance2D(ally) <= castRange
				) {
					const distToTarget = ally.Distance2D(bestTarget)
					if (distToTarget < minAllyDist && distToTarget <= 500) {
						minAllyDist = distToTarget
						closestAlly = ally
					}
				}
			}

			if (closestAlly && !closestAlly.HasBuffByName("modifier_lich_frost_shield")) {
				return closestAlly
			}
		}

		// Default: self-cast on Lich if within 650 radius of target to apply slow and pulse damage
		if (hero.Distance2D(bestTarget) <= 650 && !hero.HasBuffByName("modifier_lich_frost_shield")) {
			return hero
		}

		return undefined
	}

	/**
	 * Intercepts unit orders during Sinister Gaze channel:
	 * Allows all spell and item casts, and allows Stop (S) / Hold (H).
	 * Blocks accidental Move and Attack orders so the channel is never broken by misclicks!
	 */
	private onPrepareUnitOrders(order: ExecuteOrder): false | void {
		if (!this.protectGazeChannel.value || !this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (!this.isGazing(hero)) {
			return
		}

		const isLichIssuer = order.Issuers.length === 0 || order.Issuers.some(u => u === hero || u.Index === hero.Index)

		if (!isLichIssuer) {
			return
		}

		// Allow manual STOP ("S") and HOLD ("H") to deliberately cancel Gaze
		if (
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_STOP ||
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_HOLD_POSITION
		) {
			return
		}

		// If Lich has Scepter, all ability and item casts are permitted during Gaze!
		if (hero.HasScepter) {
			if (
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET_TREE ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT ||
				order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_AUTO
			) {
				return
			}
		}

		// Allow Glimmer Cape and Shiva's Guard (never break channeling even without Scepter)
		const ability = order.Ability_
		if (
			ability &&
			typeof ability !== "number" &&
			(ability.Name === "item_glimmer_cape" || ability.Name === "item_shivas_guard")
		) {
			return
		}

		// Block Move and Attack orders that would break the channel
		return false
	}

	/**
	 * Defensive Auto Frost Shield: protects allies or Lich under physical attack when HP is low.
	 */
	private handleAutoSaveFrostShield(hero: Hero): boolean {
		if (!this.autoSaveAllyShield.value || this.saveSleeper.Sleeping) {
			return false
		}

		const shield = hero.GetAbilityByName("lich_frost_shield")
		if (!shield || !shield.IsValid || shield.Level <= 0 || shield.Cooldown > 0.1 || hero.Mana < shield.ManaCost) {
			return false
		}

		const castRange = shield.CastRange > 0 ? shield.CastRange : 750
		const hpThreshold = this.autoSaveAllyHpPct.value

		const candidates: Hero[] = [hero]
		for (const ally of EntityManager.GetEntitiesByClass(Hero)) {
			if (
				ally.IsValid &&
				ally.IsAlive &&
				!ally.IsEnemy(hero) &&
				ally !== hero &&
				!ally.IsIllusion &&
				hero.Distance2D(ally) <= castRange
			) {
				candidates.push(ally)
			}
		}

		for (const candidate of candidates) {
			const hpPct = (candidate.HP / candidate.MaxHP) * 100
			if (hpPct <= hpThreshold && !candidate.HasBuffByName("modifier_lich_frost_shield")) {
				const hasNearbyEnemy = EntityManager.GetEntitiesByClass(Hero).some(
					e => e.IsValid && e.IsAlive && e.IsEnemy(hero) && !e.IsIllusion && candidate.Distance2D(e) <= 800
				)

				if (hasNearbyEnemy) {
					claimOrder()
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: candidate.Index,
						ability: shield.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					this.saveSleeper.Sleep(shield.CastPoint * 1000 + 200)
					return true
				}
			}
		}

		return false
	}

	/**
	 * Background Auto Sinister Gaze interrupt on high-priority enemy channeling.
	 */
	private handleAutoInterruptGaze(hero: Hero): boolean {
		if (!this.autoInterruptGaze.value || this.interruptSleeper.Sleeping) {
			return false
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return false
		}

		const gaze = hero.GetAbilityByName("lich_sinister_gaze")
		if (!gaze || !gaze.IsValid || gaze.Level <= 0 || gaze.Cooldown > 0.1 || hero.Mana < gaze.ManaCost) {
			return false
		}

		const castRange = Math.min(gaze.CastRange > 0 ? gaze.CastRange : 575, this.autoInterruptRange.value)

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (
				enemy.IsValid &&
				enemy.IsAlive &&
				enemy.IsVisible &&
				enemy.IsEnemy(hero) &&
				!enemy.IsIllusion &&
				!enemy.IsMagicImmune &&
				!enemy.IsDebuffImmune &&
				enemy.IsChanneling &&
				hero.Distance2D(enemy) <= castRange + 50
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: enemy.Index,
					ability: gaze.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.interruptSleeper.Sleep(gaze.CastPoint * 1000 + 300)
				return true
			}
		}

		return false
	}

	/**
	 * Executes items that do not break channeling during Sinister Gaze (Glimmer Cape, Shiva's Guard).
	 */
	private executeGazeSafeItems(hero: Hero, bestTarget: Hero): void {
		// 1. GLIMMER CAPE (Never breaks channeling)
		if (this.itemsSelector.IsEnabled("item_glimmer_cape")) {
			const glimmer = this.getItem(hero, "item_glimmer_cape")
			if (glimmer && glimmer.Cooldown <= 0.1 && hero.Mana >= glimmer.ManaCost) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: hero.Index,
					ability: glimmer.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return
			}
		}

		// 2. SHIVA'S GUARD (Never breaks channeling)
		if (this.itemsSelector.IsEnabled("item_shivas_guard")) {
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
			}
		}
	}

	/**
	 * Executes offensive and defensive items during combo.
	 */
	private executeItems(hero: Hero, bestTarget: Hero, isTargetImmune: boolean): boolean {
		const isGazeActive = this.isGazing(hero)

		// 1. BLINK DAGGER (Only when not channeling Gaze)
		if (!isGazeActive && this.itemsSelector.IsEnabled("item_blink") && this.blinkMode.SelectedID !== 2) {
			const blink =
				this.getItem(hero, "item_blink") ||
				this.getItem(hero, "item_arcane_blink") ||
				this.getItem(hero, "item_swift_blink") ||
				this.getItem(hero, "item_overwhelming_blink")

			if (blink && blink.Cooldown <= 0.1) {
				const dist = hero.Distance2D(bestTarget)
				if (dist > 550 && dist <= 1200) {
					let blinkPos = bestTarget.Position.Clone()
					if (this.blinkMode.SelectedID === 0) {
						// Blink to 500 units in front of target
						const dir = hero.Position.Subtract(bestTarget.Position).Normalize()
						blinkPos = bestTarget.Position.Add(dir.MultiplyScalar(500))
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

		// 3. GLIMMER CAPE (Can be cast during Gaze channel!)
		if (this.itemsSelector.IsEnabled("item_glimmer_cape")) {
			const glimmer = this.getItem(hero, "item_glimmer_cape")
			if (
				glimmer &&
				glimmer.Cooldown <= 0.1 &&
				hero.Mana >= glimmer.ManaCost &&
				(isGazeActive || hero.Distance2D(bestTarget) <= 700)
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: hero.Index,
					ability: glimmer.Index,
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

		// 5. ROD OF ATOS / GLEIPNIR
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
				claimOrder()
				if (atos.Name === "item_gungir") {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
						issuers: [hero],
						position: bestTarget.Position.Clone(),
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
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 6. VEIL OF DISCORD
		if (this.itemsSelector.IsEnabled("item_veil_of_discord") && !isTargetImmune) {
			const veil = this.getItem(hero, "item_veil_of_discord")
			if (veil && veil.Cooldown <= 0.1 && hero.Mana >= veil.ManaCost && hero.Distance2D(bestTarget) <= 1000) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: bestTarget.Position.Clone(),
					ability: veil.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				this.sleeper.Sleep(GameState.InputLag * 1000 + 80)
				return true
			}
		}

		// 7. ORCHID / BLOODTHORN
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

		// 9. DAGON
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

		// 11. SPIRIT VESSEL / URN
		if (
			(this.itemsSelector.IsEnabled("item_spirit_vessel") ||
				this.itemsSelector.IsEnabled("item_urn_of_shadows")) &&
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

		// 12. REFRESHER ORB
		if (this.itemsSelector.IsEnabled("item_refresher")) {
			const refresher = this.getItem(hero, "item_refresher") || this.getItem(hero, "item_refresher_shard")
			const ult = hero.GetAbilityByName("lich_chain_frost")
			const gaze = hero.GetAbilityByName("lich_sinister_gaze")

			if (
				refresher &&
				refresher.Cooldown <= 0.1 &&
				hero.Mana >= refresher.ManaCost + 300 &&
				ult &&
				ult.Cooldown > 5 &&
				gaze &&
				gaze.Cooldown > 3 &&
				!isGazeActive
			) {
				claimOrder()
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
					issuers: [hero],
					ability: refresher.Index,
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

		// Target HUD info
		if (this.lockedTarget && this.lockedTarget.IsValid && this.lockedTarget.IsAlive) {
			const screenPos = RendererSDK.WorldToScreen(this.lockedTarget.Position)
			if (screenPos) {
				const isGazing = this.isGazing(hero)
				const bounces = this.countChainFrostBounceTargets(hero, this.lockedTarget)

				let statusText = `Lich Target (Bounces: ${bounces})`
				let textColor = Color.White
				if (isGazing) {
					statusText = "SINISTER GAZE (Bursting...)"
					textColor = new Color(0, 255, 255, 255)
				}

				RendererSDK.Text(statusText, screenPos.Add(new Vector2(-50, 30)), textColor, "Arial", 12)
			}
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		if (this.sleeper.lastSleepTickCount > (GameState.RawGameTime + 60) * 1000) {
			this.sleeper.ResetTimer()
			this.saveSleeper.ResetTimer()
			this.interruptSleeper.ResetTimer()
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("lich_target_ring")
			return
		}

		// 1. Background Auto Save Frost Shield
		if (this.handleAutoSaveFrostShield(hero)) {
			return
		}

		// 2. Background Auto Interrupt Sinister Gaze
		if (this.handleAutoInterruptGaze(hero)) {
			return
		}

		// 3. Check Combo Hotkey
		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("lich_target_ring")
			return
		}

		if (hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// Target Selection & Locking
		let bestTarget: Hero | undefined = this.lockedTarget
		if (!bestTarget || !bestTarget.IsValid || !bestTarget.IsAlive || !bestTarget.IsVisible) {
			const mousePos = InputManager.CursorOnWorld
			let minDist = Infinity
			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (
					enemy.IsValid &&
					enemy.IsAlive &&
					enemy.IsVisible &&
					enemy.IsEnemy(hero) &&
					!enemy.IsIllusion &&
					isRealHero(enemy)
				) {
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
			this.pSDK.DestroyByKey("lich_target_ring")
			return
		}

		this.pSDK.DrawCircle("lich_target_ring", bestTarget, 130, {
			Color: new Color(0, 180, 255, 220),
			Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
		})

		if (this.sleeper.Sleeping) {
			return
		}

		const isGazeActive = this.isGazing(hero)
		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		// If channeling Sinister Gaze:
		// In Dota 2, Lich can ONLY cast spells & items during Sinister Gaze IF he possesses Aghanim's Scepter!
		// Without Scepter, casting any ability will immediately break the channel in Dota 2.
		if (isGazeActive && (!hero.HasScepter || !this.allowSpellsDuringGaze.value)) {
			this.executeGazeSafeItems(hero, bestTarget)
			return
		}

		// Execute Items
		if (this.executeItems(hero, bestTarget, isTargetImmune)) {
			return
		}

		// Skill Rotation Execution
		if (this.comboSequenceGrid) {
			for (const actionName of this.comboSequenceGrid.values) {
				if (!this.comboSequenceGrid.IsEnabled(actionName)) {
					continue
				}

				// 1. SINISTER GAZE (E)
				if (actionName === "lich_sinister_gaze" && !isGazeActive) {
					const gaze = hero.GetAbilityByName("lich_sinister_gaze")
					if (
						gaze &&
						gaze.IsValid &&
						gaze.Level > 0 &&
						gaze.Cooldown <= 0.1 &&
						hero.Mana >= gaze.ManaCost &&
						!isTargetImmune
					) {
						const castRange = gaze.CastRange > 0 ? gaze.CastRange : 575
						if (hero.Distance2D(bestTarget) <= castRange + 100) {
							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: gaze.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + gaze.CastPoint * 1000 + 120)
							return
						}
					}
				}

				// 2. ICE SPIRE (D - Shard)
				else if (actionName === "lich_ice_spire") {
					const spire = hero.GetAbilityByName("lich_ice_spire")
					if (
						spire &&
						spire.IsValid &&
						spire.Level > 0 &&
						spire.Cooldown <= 0.1 &&
						hero.Mana >= spire.ManaCost
					) {
						const castRange = spire.CastRange > 0 ? spire.CastRange : 750
						if (hero.Distance2D(bestTarget) <= castRange + 150) {
							// Spawn Ice Spire between Lich and target
							const dir = hero.Position.Subtract(bestTarget.Position).Normalize()
							const offset = Math.min(this.spirePlacementOffset.value, hero.Distance2D(bestTarget) * 0.5)
							const spawnPos = bestTarget.Position.Add(dir.MultiplyScalar(offset))

							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
								issuers: [hero],
								position: spawnPos,
								ability: spire.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + spire.CastPoint * 1000 + 100)
							return
						}
					}
				}

				// 3. CHAIN FROST (R - Ultimate)
				else if (actionName === "lich_chain_frost") {
					const ult = hero.GetAbilityByName("lich_chain_frost")
					if (ult && ult.IsValid && ult.Level > 0 && ult.Cooldown <= 0.1 && hero.Mana >= ult.ManaCost) {
						const castRange = ult.CastRange > 0 ? ult.CastRange : 800
						if (hero.Distance2D(bestTarget) <= castRange + 100) {
							const spire = hero.GetAbilityByName("lich_ice_spire")
							const hasSpireAvailable = Boolean(
								spire &&
									spire.IsValid &&
									spire.Level > 0 &&
									spire.Cooldown <= 0.1 &&
									hero.Mana >= spire.ManaCost + ult.ManaCost
							)

							// If autoSpireBeforeChain is enabled and Spire is ready, spawn Spire first!
							if (this.autoSpireBeforeChain.value && hasSpireAvailable && spire) {
								const dir = hero.Position.Subtract(bestTarget.Position).Normalize()
								const offset = Math.min(
									this.spirePlacementOffset.value,
									hero.Distance2D(bestTarget) * 0.5
								)
								const spawnPos = bestTarget.Position.Add(dir.MultiplyScalar(offset))

								claimOrder()
								ExecuteOrder.PrepareOrder({
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
									issuers: [hero],
									position: spawnPos,
									ability: spire.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								})
								this.sleeper.Sleep(GameState.InputLag * 1000 + spire.CastPoint * 1000 + 100)
								return
							}

							// Check bounce capacity
							const bounces = this.countChainFrostBounceTargets(hero, bestTarget)
							const canBounce = !this.requireBounceTarget.value || bounces >= 2

							if (canBounce) {
								claimOrder()
								ExecuteOrder.PrepareOrder({
									orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
									issuers: [hero],
									target: bestTarget.Index,
									ability: ult.Index,
									queue: false,
									showEffects: true,
									isPlayerInput: false
								})
								this.sleeper.Sleep(GameState.InputLag * 1000 + ult.CastPoint * 1000 + 120)
								return
							}
						}
					}
				}

				// 4. FROST NOVA (Q)
				else if (actionName === "lich_frost_nova") {
					const nova = hero.GetAbilityByName("lich_frost_nova")
					if (nova && nova.IsValid && nova.Level > 0 && nova.Cooldown <= 0.1 && hero.Mana >= nova.ManaCost) {
						const castRange = nova.CastRange > 0 ? nova.CastRange : 600
						if (hero.Distance2D(bestTarget) <= castRange + 100) {
							claimOrder()
							ExecuteOrder.PrepareOrder({
								orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
								issuers: [hero],
								target: bestTarget.Index,
								ability: nova.Index,
								queue: false,
								showEffects: true,
								isPlayerInput: false
							})
							this.sleeper.Sleep(GameState.InputLag * 1000 + nova.CastPoint * 1000 + 100)
							return
						}
					}
				}

				// 5. FROST SHIELD (W)
				else if (actionName === "lich_frost_shield") {
					const shieldTarget = this.getBestFrostShieldTarget(hero, bestTarget)
					const shield = hero.GetAbilityByName("lich_frost_shield")
					if (shieldTarget && shield && shield.IsValid && shield.Cooldown <= 0.1) {
						claimOrder()
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: shieldTarget.Index,
							ability: shield.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + shield.CastPoint * 1000 + 100)
						return
					}
				}
			}
		}

		// Smart Orb Walk:
		// STRICTLY do not orbwalk / move / attack if Lich is actively channeling Sinister Gaze!
		if (!isGazeActive) {
			executeOrbwalk(hero, bestTarget, this.sleeper, {
				enabled: this.smartOrbWalkEnabled.value,
				safeDistancePct: this.smartOrbWalkDistancePct.value,
				stopToCancel: false
			})
		}
	}
})()
