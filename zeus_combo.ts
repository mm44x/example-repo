import {
	Ability,
	Color,
	Creep,
	DAMAGE_TYPES,
	DOTA_ABILITY_BEHAVIOR,
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
	modifier_zuus_static_field,
	RendererSDK,
	TickSleeper,
	Unit,
	UnitPortalData,
	Vector2,
	Vector3,
	VMouseKeys
} from "github.com/octarine-public/wrapper/index"

import { executeOrbwalk } from "./orbwalker"

const COMBO_SPELLS = [
	"zuus_cloud",
	"zuus_lightning_bolt",
	"zuus_arc_lightning",
	"zuus_heavenly_jump",
	"zuus_thundergods_wrath"
]

const KS_SPELLS = [
	"zuus_arc_lightning",
	"zuus_lightning_bolt",
	"zuus_heavenly_jump",
	"zuus_cloud",
	"zuus_thundergods_wrath"
]

const KS_ITEMS = [
	"item_dagon",
	"item_ethereal_blade",
	"item_veil_of_discord",
	"item_shivas_guard",
	"item_orchid",
	"item_bloodthorn"
]

new (class ZeusCombo {
	private readonly entry = Menu.AddEntry("mm44x")
		.AddNode("Combo Heroes", "menu/icons/juggernaut.svg")
		.AddNode("Zeus Combo", "panorama/images/heroes/icons/npc_dota_hero_zuus_png.vtex_c", "", 0)

	// Main Combo Settings
	private readonly comboEnabled = this.entry.AddToggle("Enable Combo", true, "Enable/Disable Zeus combo script")
	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Zeus combo")
	private readonly lockTargetEnabled = this.entry.AddToggle(
		"Lock Target During Combo",
		true,
		"Locks onto the initial target while combo key is pressed"
	)
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 900, 300, 1800, 50)
	private readonly useBlink = this.entry.AddToggle(
		"Use Blink in Combo",
		true,
		"Blink towards target if out of spell range"
	)
	private readonly blinkMinDistance = this.entry.AddSlider("Blink Min Distance", 450, 200, 900, 50)
	private readonly useUltInCombo = this.entry.AddToggle(
		"Use Wrath (R) in Combo",
		false,
		"Cast Thundergod's Wrath during combo if target HP is below threshold"
	)
	private readonly ultComboHpThreshold = this.entry.AddSlider("Wrath (R) Target HP %", 35, 10, 80, 5)

	// Items Selection for Combo
	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items in Combo",
		[
			"item_sheepstick",
			"item_orchid",
			"item_bloodthorn",
			"item_ethereal_blade",
			"item_veil_of_discord",
			"item_shivas_guard",
			"item_dagon",
			"item_refresher",
			"item_soul_ring",
			"item_arcane_boots",
			"item_black_king_bar",
			"item_blink"
		],
		new Map([
			["item_sheepstick", true],
			["item_orchid", true],
			["item_bloodthorn", true],
			["item_ethereal_blade", true],
			["item_veil_of_discord", true],
			["item_shivas_guard", true],
			["item_dagon", true],
			["item_refresher", true],
			["item_soul_ring", true],
			["item_arcane_boots", true],
			["item_black_king_bar", false],
			["item_blink", true]
		]),
		"Toggle items to cast during combo"
	)

	// Smart Orb Walk
	private readonly smartOrbWalkEnabled = this.entry.AddToggle(
		"Enable Smart Orb Walk",
		true,
		"Follow moving targets while weaving attacks/Lightning Hands"
	)
	private readonly smartOrbWalkDistancePct = this.entry.AddSlider("Orb Walk Safe Distance %", 80, 10, 100, 5)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle("Stop-to-Cancel Backswing", false)

	// ==========================================
	// KILL STEAL MENU & OPTIONS
	// ==========================================
	private readonly ksNode = this.entry.AddNode(
		"Kill Steal",
		"panorama/images/spellicons/zuus_thundergods_wrath_png.vtex_c",
		"",
		0
	)
	private readonly enableKS = this.ksNode.AddToggle(
		"Enable Kill Steal",
		true,
		"Master ON/OFF toggle for automatic Kill Steal"
	)

	// Skills in Kill Steal
	private readonly ksSkillsSelector = this.ksNode.AddImageSelector(
		"Kill Steal Skills",
		KS_SPELLS,
		new Map([
			["zuus_arc_lightning", true],
			["zuus_lightning_bolt", true],
			["zuus_heavenly_jump", true],
			["zuus_cloud", true],
			["zuus_thundergods_wrath", true]
		]),
		"Select which skills can be used for Kill Steal"
	)

	// Items in Kill Steal
	private readonly ksItemsSelector = this.ksNode.AddImageSelector(
		"Kill Steal Items",
		KS_ITEMS,
		new Map([
			["item_dagon", true],
			["item_ethereal_blade", true],
			["item_veil_of_discord", true],
			["item_shivas_guard", true],
			["item_orchid", true],
			["item_bloodthorn", true]
		]),
		"Select which items can be used for Kill Steal"
	)

	// Global Priority: Nimbus vs Wrath
	private readonly ksGlobalPriority = this.ksNode.AddDropdown(
		"Global KS Priority",
		["Nimbus First (Save Ult)", "Wrath First (Instant Global)"],
		0,
		"Choose which global ability to prioritize for Kill Steal"
	)

	// Anti-Overkill Guard
	private readonly ksAntiOverkill = this.ksNode.AddToggle(
		"Anti-Overkill (Don't waste Wrath if Nimbus active)",
		true,
		"Prevents casting both Nimbus and Wrath on the same killable target"
	)

	// Combo Kill Steal (Burst multi-spell/item KS)
	private readonly ksComboKill = this.ksNode.AddToggle(
		"Enable Combo Kill Steal",
		true,
		"Cast multi-spell burst (e.g. E-Blade + Dagon / Bolt) if single spell isn't enough"
	)

	// Thundergod's Wrath (R) KS Specific Settings
	private readonly ksWrathMinEnemies = this.ksNode.AddSlider(
		"Wrath (R) Min Killable Count",
		1,
		1,
		5,
		1,
		"Minimum number of killable enemies required to auto-trigger Wrath"
	)
	private readonly ksWrathCustomKey = this.ksNode.AddKeybind(
		"Manual Wrath KS Key",
		"None",
		"Press to execute Wrath KS immediately if at least 1 enemy is killable"
	)
	private readonly ksWrathCheckInvisible = this.ksNode.AddToggle(
		"Wrath on Invisible / In-Fog Enemies",
		true,
		"Calculate Wrath damage for invisible / unseen enemies in fog"
	)

	// Safety & Immunity Checks
	private readonly ksCheckBladeMail = this.ksNode.AddToggle(
		"Avoid Blade Mail / Lotus Orb",
		true,
		"Do not KS enemies with active Blade Mail or Lotus Orb"
	)

	// ==========================================
	// NIMBUS AUTO INTERRUPTER MENU
	// ==========================================
	private readonly interrupterNode = this.entry.AddNode("Auto Nimbus Interrupter")
	private readonly enableNimbusInterrupter = this.interrupterNode.AddToggle(
		"Auto Nimbus on Channeling",
		true,
		"Automatically drop Nimbus on channeling enemies"
	)
	private readonly nimbusInterruptSpells = this.interrupterNode.AddToggle(
		"Interrupt Channeling Spells",
		true,
		"Cancel Black Hole, Freezing Field, Death Ward, Fiend's Grip, Shackles, Dismember, etc."
	)
	private readonly nimbusInterruptTeleport = this.interrupterNode.AddToggle(
		"Interrupt Teleport (TP)",
		true,
		"Cancel enemy Town Portal Scroll / Boots of Travel / Nature's Prophet TP"
	)
	private readonly nimbusInterruptFogTeleport = this.interrupterNode.AddToggle(
		"Interrupt Teleport in Fog of War",
		true,
		"Cancel enemy Teleports globally even if hidden in Fog of War"
	)
	private readonly nimbusInterruptTwinGate = this.interrupterNode.AddToggle(
		"Interrupt Twin Gate",
		true,
		"Cancel enemy Twin Gate channeling"
	)

	// Auto Harass / Farm Q
	private readonly autoQNode = this.entry.AddNode("Auto Arc (Q) Harass / Farm")
	private readonly enableAutoQ = this.autoQNode.AddToggle("Enable Auto Arc (Q)", false)
	private readonly autoQKey = this.autoQNode.AddKeybind(
		"Auto Arc (Q) Hold Key",
		"2",
		"Hold key to auto cast Arc Lightning"
	)
	private readonly autoQMode = this.autoQNode.AddDropdown(
		"Target Mode",
		["Harass Heroes Only", "Last Hit Creeps + Harass"],
		1
	)
	private readonly autoQMinManaPct = this.autoQNode.AddSlider("Min Mana %", 40, 10, 90, 5)

	// Defensive Heavenly Jump
	private readonly jumpNode = this.entry.AddNode("Defensive Heavenly Jump")
	private readonly enableAutoJump = this.jumpNode.AddToggle(
		"Auto Defensive Jump",
		true,
		"Auto jump when enemies get too close"
	)
	private readonly autoJumpEnemyRange = this.jumpNode.AddSlider("Trigger Enemy Distance", 350, 200, 600, 25)
	private readonly autoJumpHpThreshold = this.jumpNode.AddSlider("Trigger Zeus HP %", 50, 10, 100, 5)

	// HUD & Visuals
	private readonly showTargetCircle = this.entry.AddToggle("Draw Target Lock Indicator", true)
	private readonly showKillableHUD = this.entry.AddToggle("Draw Killable Enemies HUD", true)
	private readonly showStatusHUD = this.entry.AddToggle("Draw Status HUD", true)
	private statusHudPos = new Vector2(50, 400)
	private isDraggingStatus = false

	private comboSequenceGrid: any
	private lockedTarget: Hero | undefined = undefined

	// Active Cast Tracking (Prevents Overkill / Double Cast)
	private activeNimbusCastList: { position: Vector3; expireTime: number; targetIndex: number }[] = []
	private lastWrathCastTime = 0

	// Sleepers
	private readonly sleeper = new TickSleeper()
	private readonly ksSleeper = new TickSleeper()
	private readonly interrupterSleeper = new TickSleeper()
	private readonly autoQSleeper = new TickSleeper()
	private readonly autoJumpSleeper = new TickSleeper()

	constructor() {
		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		COMBO_SPELLS.forEach((name, i) => defaultCombo.set(name, [true, true, true, i]))

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector("Combo Order", COMBO_SPELLS, defaultCombo)

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("UnitPortalChanged", this.onUnitPortalChanged.bind(this))
		EventsSDK.on("Draw", this.Draw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private get hasLocalHero(): boolean {
		return LocalPlayer?.Hero?.IsValid === true && LocalPlayer.Hero.Name === "npc_dota_hero_zuus"
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.ksSleeper.Sleep(0)
		this.interrupterSleeper.Sleep(0)
		this.autoQSleeper.Sleep(0)
		this.autoJumpSleeper.Sleep(0)
		this.lockedTarget = undefined
		this.activeNimbusCastList = []
		this.lastWrathCastTime = 0
	}

	/**
	 * Robust Nimbus (zuus_cloud) ability lookup.
	 * In Dota 2, Nimbus is granted by Aghanim's Scepter.
	 */
	private getNimbusAbility(hero: Hero): Ability | undefined {
		const nimbus = hero.GetAbilityByName("zuus_cloud")
		if (!nimbus || !nimbus.IsValid) {
			return undefined
		}
		const hasAghs = hero.HasScepter || nimbus.Level > 0 || !nimbus.IsHidden
		if (!hasAghs) {
			return undefined
		}
		return nimbus
	}

	/**
	 * Checks if an enemy hero is currently inside an active Nimbus cloud strike zone.
	 */
	private isEnemyUnderActiveNimbus(enemy: Hero): boolean {
		if (!this.ksAntiOverkill.value) {
			return false
		}
		const now = GameState.RawGameTime
		this.activeNimbusCastList = this.activeNimbusCastList.filter(n => n.expireTime > now)
		return this.activeNimbusCastList.some(
			n => n.targetIndex === enemy.Index || n.position.Distance2D(enemy.Position) <= 450
		)
	}

	// ==========================================
	// DAMAGE FORMULAS WITH STATIC FIELD
	// ==========================================

	private getArcDamage(hero: Hero, target: Unit): number {
		const arc = hero.GetAbilityByName("zuus_arc_lightning")
		if (!arc || arc.Level === 0) {
			return 0
		}
		const lvl = Math.max(1, arc.Level)
		let dmg =
			arc.GetSpecialValue("arc_damage", lvl) ||
			arc.GetBaseDamageForLevel(lvl) ||
			[85, 110, 135, 160][lvl - 1] ||
			160
		const staticField = hero.GetBuffByClass(modifier_zuus_static_field)
		if (staticField) {
			dmg += staticField.GetBonusDamage(target)
		}
		return dmg
	}

	private getBoltDamage(hero: Hero, target: Unit): number {
		const bolt = hero.GetAbilityByName("zuus_lightning_bolt")
		if (!bolt || bolt.Level === 0) {
			return 0
		}
		const lvl = Math.max(1, bolt.Level)
		let dmg =
			bolt.GetSpecialValue("damage", lvl) ||
			bolt.GetBaseDamageForLevel(lvl) ||
			[125, 200, 275, 350][lvl - 1] ||
			350
		const staticField = hero.GetBuffByClass(modifier_zuus_static_field)
		if (staticField) {
			dmg += staticField.GetBonusDamage(target)
		}
		return dmg
	}

	private getJumpDamage(hero: Hero, target: Unit): number {
		const jump = hero.GetAbilityByName("zuus_heavenly_jump")
		if (!jump || jump.Level === 0) {
			return 0
		}
		const lvl = Math.max(1, jump.Level)
		let dmg =
			jump.GetSpecialValue("damage", lvl) ||
			jump.GetBaseDamageForLevel(lvl) ||
			[100, 160, 220, 280][lvl - 1] ||
			200
		const staticField = hero.GetBuffByClass(modifier_zuus_static_field)
		if (staticField) {
			dmg += staticField.GetBonusDamage(target)
		}
		return dmg
	}

	private getNimbusDamage(hero: Hero, target: Unit): number {
		const bolt = hero.GetAbilityByName("zuus_lightning_bolt")
		const lvl = bolt && bolt.Level > 0 ? bolt.Level : 4
		let dmg = bolt ? bolt.GetSpecialValue("damage", lvl) || bolt.GetBaseDamageForLevel(lvl) : 0
		if (!dmg || dmg <= 0) {
			dmg = [125, 200, 275, 350][lvl - 1] ?? 350
		}
		const staticField = hero.GetBuffByClass(modifier_zuus_static_field)
		if (staticField) {
			dmg += staticField.GetBonusDamage(target)
		}
		return dmg
	}

	private getWrathDamage(hero: Hero, target: Unit): number {
		const wrath = hero.GetAbilityByName("zuus_thundergods_wrath")
		if (!wrath || wrath.Level === 0) {
			return 0
		}
		const lvl = Math.max(1, wrath.Level)
		let dmg =
			wrath.GetSpecialValue("damage", lvl) || wrath.GetBaseDamageForLevel(lvl) || [300, 425, 550][lvl - 1] || 450
		const staticField = hero.GetBuffByClass(modifier_zuus_static_field)
		if (staticField) {
			dmg += staticField.GetBonusDamage(target)
		}
		return dmg
	}

	/**
	 * Instant event-driven reaction when any unit in the game starts Teleporting.
	 */
	private onUnitPortalChanged(portal: UnitPortalData): void {
		if (
			!this.enableNimbusInterrupter.value ||
			!this.nimbusInterruptTeleport.value ||
			ExecuteOrder.DisableHumanizer ||
			!this.hasLocalHero ||
			this.interrupterSleeper.Sleeping
		) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		const caster = portal.Caster
		if (!caster || !caster.IsValid || !caster.IsAlive || !caster.IsEnemy(hero) || caster.IsIllusion) {
			return
		}

		const startPos = portal.StartPosition
		if (!startPos || !startPos.IsValid) {
			return
		}

		if (caster instanceof Hero && this.isSpellImmuneOrUninterruptible(caster)) {
			return
		}

		// Check fog settings
		if (!caster.IsVisible && !this.nimbusInterruptFogTeleport.value) {
			return
		}

		const nimbus = this.getNimbusAbility(hero)
		const nimbusManaCost = nimbus && nimbus.ManaCost > 0 ? nimbus.ManaCost : 325
		if (!nimbus || nimbus.Cooldown > 0.1 || hero.Mana < nimbusManaCost) {
			return
		}

		this.castPosition(hero, nimbus, startPos)
		this.activeNimbusCastList.push({
			position: startPos.Clone(),
			expireTime: GameState.RawGameTime + 3.0,
			targetIndex: caster.Index
		})
		this.interrupterSleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 250)
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		// 1. Nimbus Channeling & Teleport Interrupter (Highest priority background check)
		if (this.enableNimbusInterrupter.value && !this.interrupterSleeper.Sleeping) {
			if (this.handleNimbusInterrupter(hero)) {
				return
			}
		}

		// 2. Auto Kill Steal (KS)
		if (this.enableKS.value && !this.ksSleeper.Sleeping) {
			if (this.handleKillSteal(hero)) {
				return
			}
		}

		// 3. Defensive Heavenly Jump
		if (this.enableAutoJump.value && !this.autoJumpSleeper.Sleeping) {
			if (this.handleDefensiveJump(hero)) {
				return
			}
		}

		// 4. Auto Arc Lightning Harass / Farm
		// @ts-ignore
		if (this.enableAutoQ.value && this.autoQKey.isPressed && !this.autoQSleeper.Sleeping) {
			if (this.handleAutoQ(hero)) {
				return
			}
		}

		// 5. Main Zeus Combo
		if (!this.comboEnabled.value) {
			return
		}

		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			return
		}

		this.handleMainCombo(hero)
	}

	// ==========================================
	// MAIN COMBO LOGIC
	// ==========================================

	private handleMainCombo(hero: Hero): void {
		const target = this.getTarget(hero)
		if (!target || !target.IsValid || !target.IsAlive || !target.IsVisible) {
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		const targetDist = hero.Distance2D(target)

		// 1. Soul Ring for free mana before dumping combo
		const soulRing = hero.Items.find(i => i.Name === "item_soul_ring")
		if (
			soulRing &&
			this.itemsSelector.IsEnabled("item_soul_ring") &&
			soulRing.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.HP > 300
		) {
			this.castNoTarget(hero, soulRing)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// 2. Black King Bar (BKB) if enabled and in combat
		const bkb = hero.Items.find(i => i.Name === "item_black_king_bar")
		if (bkb && this.itemsSelector.IsEnabled("item_black_king_bar") && bkb.Cooldown <= 0.1 && !hero.IsMuted) {
			this.castNoTarget(hero, bkb)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// 3. Blink towards target if enabled & out of comfortable spell range
		const blink = hero.Items.find(
			i =>
				i.Name === "item_blink" ||
				i.Name === "item_arcane_blink" ||
				i.Name === "item_swift_blink" ||
				i.Name === "item_overwhelming_blink"
		)
		if (
			blink &&
			this.useBlink.value &&
			this.itemsSelector.IsEnabled("item_blink") &&
			blink.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= blink.ManaCost &&
			targetDist > this.blinkMinDistance.value &&
			targetDist <= 1200 + this.blinkMinDistance.value
		) {
			const blinkPos = hero.Position.Extend(target.Position, Math.min(targetDist - 400, 1150))
			this.castPosition(hero, blink, blinkPos)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return
		}

		// 4. Scythe of Vyse (Hex) - Disable target first
		const hex = hero.Items.find(i => i.Name === "item_sheepstick")
		if (
			hex &&
			this.itemsSelector.IsEnabled("item_sheepstick") &&
			hex.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= hex.ManaCost &&
			targetDist <= (hex.CastRange || 800) &&
			!target.IsHexed &&
			!target.IsStunned &&
			!this.isImmuneOrInvulnerable(target)
		) {
			this.castTarget(hero, hex, target)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return
		}

		// 5. Orchid / Bloodthorn (Silence & Damage Amp)
		const bloodthorn = hero.Items.find(i => i.Name === "item_bloodthorn" || i.Name === "item_orchid")
		if (
			bloodthorn &&
			(this.itemsSelector.IsEnabled("item_bloodthorn") || this.itemsSelector.IsEnabled("item_orchid")) &&
			bloodthorn.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= bloodthorn.ManaCost &&
			targetDist <= (bloodthorn.CastRange || 900) &&
			!target.IsSilenced &&
			!target.IsHexed &&
			!this.isImmuneOrInvulnerable(target)
		) {
			this.castTarget(hero, bloodthorn, target)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return
		}

		// 6. Ethereal Blade (Magic Amp + Slow)
		const eblade = hero.Items.find(i => i.Name === "item_ethereal_blade")
		if (
			eblade &&
			this.itemsSelector.IsEnabled("item_ethereal_blade") &&
			eblade.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= eblade.ManaCost &&
			targetDist <= (eblade.CastRange || 800) &&
			!this.isImmuneOrInvulnerable(target)
		) {
			this.castTarget(hero, eblade, target)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return
		}

		// 7. Veil of Discord (Magic Amp)
		const veil = hero.Items.find(i => i.Name === "item_veil_of_discord")
		if (
			veil &&
			this.itemsSelector.IsEnabled("item_veil_of_discord") &&
			veil.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= veil.ManaCost &&
			targetDist <= (veil.CastRange || 900) &&
			!this.isImmuneOrInvulnerable(target)
		) {
			if (veil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
				this.castTarget(hero, veil, target)
			} else {
				this.castNoTarget(hero, veil)
			}
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return
		}

		// 8. Shiva's Guard (AoE slow & damage)
		const shiva = hero.Items.find(i => i.Name === "item_shivas_guard")
		if (
			shiva &&
			this.itemsSelector.IsEnabled("item_shivas_guard") &&
			shiva.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= shiva.ManaCost &&
			targetDist <= 900
		) {
			this.castNoTarget(hero, shiva)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return
		}

		// 9. Dagon (Nuke)
		const dagon = this.getDagonItem(hero)
		if (
			dagon &&
			this.itemsSelector.IsEnabled("item_dagon") &&
			dagon.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= dagon.ManaCost &&
			targetDist <= (dagon.CastRange || 700) &&
			!this.isImmuneOrInvulnerable(target)
		) {
			this.castTarget(hero, dagon, target)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
			return
		}

		// 10. Execute Spells according to user configured Combo Order
		const sortedSpells = this.getSortedSpells()

		for (const spellName of sortedSpells) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			// Spell: Nimbus (zuus_cloud)
			if (spellName === "zuus_cloud") {
				const nimbus = this.getNimbusAbility(hero)
				const nimbusCost = nimbus && nimbus.ManaCost > 0 ? nimbus.ManaCost : 325
				if (
					nimbus &&
					nimbus.Cooldown <= 0.1 &&
					hero.Mana >= nimbusCost &&
					!this.isImmuneOrInvulnerable(target)
				) {
					this.castPosition(hero, nimbus, target.Position)
					this.activeNimbusCastList.push({
						position: target.Position.Clone(),
						expireTime: GameState.RawGameTime + 3.0,
						targetIndex: target.Index
					})
					this.sleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 100)
					return
				}
				continue
			}

			const ability = hero.GetAbilityByName(spellName)
			if (
				!ability ||
				!ability.IsValid ||
				ability.Level === 0 ||
				ability.Cooldown > 0.1 ||
				hero.Mana < ability.ManaCost
			) {
				continue
			}

			// Spell: Lightning Bolt (zuus_lightning_bolt)
			if (spellName === "zuus_lightning_bolt") {
				const castRange = ability.CastRange > 0 ? ability.CastRange : 700
				if (targetDist <= castRange + 150 && !this.isImmuneOrInvulnerable(target)) {
					this.castTarget(hero, ability, target)
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

			// Spell: Arc Lightning (zuus_arc_lightning)
			if (spellName === "zuus_arc_lightning") {
				const castRange = ability.CastRange > 0 ? ability.CastRange : 850
				if (targetDist <= castRange + 150 && !this.isImmuneOrInvulnerable(target)) {
					this.castTarget(hero, ability, target)
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

			// Spell: Heavenly Jump (zuus_heavenly_jump)
			if (spellName === "zuus_heavenly_jump") {
				const jumpRange = 700
				if (targetDist <= jumpRange && !this.isImmuneOrInvulnerable(target)) {
					this.castNoTarget(hero, ability)
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					return
				}
			}

			// Spell: Thundergod's Wrath (zuus_thundergods_wrath)
			if (spellName === "zuus_thundergods_wrath" && this.useUltInCombo.value) {
				const hpPct = (target.HP / target.MaxHP) * 100
				if (hpPct <= this.ultComboHpThreshold.value && !this.isImmuneOrInvulnerable(target)) {
					this.castNoTarget(hero, ability)
					this.lastWrathCastTime = GameState.RawGameTime
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 150)
					return
				}
			}
		}

		// 11. Refresher Orb / Shard
		const refresher = hero.Items.find(i => i.Name === "item_refresher" || i.Name === "item_refresher_shard")
		const bolt = hero.GetAbilityByName("zuus_lightning_bolt")
		const ult = hero.GetAbilityByName("zuus_thundergods_wrath")
		if (
			refresher &&
			this.itemsSelector.IsEnabled("item_refresher") &&
			refresher.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= refresher.ManaCost + 300 &&
			bolt &&
			bolt.Cooldown > 1.5 &&
			(!ult || ult.Cooldown > 5 || ult.Level === 0)
		) {
			this.castNoTarget(hero, refresher)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 150)
			return
		}

		// 12. Arcane Boots if mana is getting low
		const arcane = hero.Items.find(i => i.Name === "item_arcane_boots")
		if (
			arcane &&
			this.itemsSelector.IsEnabled("item_arcane_boots") &&
			arcane.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana < hero.MaxMana - 175
		) {
			this.castNoTarget(hero, arcane)
			this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
			return
		}

		// Fallback: Weave attacks with Orbwalker
		executeOrbwalk(hero, target, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}

	// ==========================================
	// ALL KILL STEAL (SKILLS + ITEMS + COMBO)
	// ==========================================

	private handleKillSteal(hero: Hero): boolean {
		if (hero.IsMuted && hero.IsSilenced) {
			return false
		}

		const bolt = hero.GetAbilityByName("zuus_lightning_bolt")
		const arc = hero.GetAbilityByName("zuus_arc_lightning")
		const jump = hero.GetAbilityByName("zuus_heavenly_jump")
		const nimbus = this.getNimbusAbility(hero)
		const wrath = hero.GetAbilityByName("zuus_thundergods_wrath")

		const isBoltReady =
			bolt &&
			this.ksSkillsSelector.IsEnabled("zuus_lightning_bolt") &&
			bolt.IsValid &&
			bolt.Level > 0 &&
			bolt.Cooldown <= 0.1 &&
			hero.Mana >= bolt.ManaCost
		const isArcReady =
			arc &&
			this.ksSkillsSelector.IsEnabled("zuus_arc_lightning") &&
			arc.IsValid &&
			arc.Level > 0 &&
			arc.Cooldown <= 0.1 &&
			hero.Mana >= arc.ManaCost
		const isJumpReady =
			jump &&
			this.ksSkillsSelector.IsEnabled("zuus_heavenly_jump") &&
			jump.IsValid &&
			jump.Level > 0 &&
			jump.Cooldown <= 0.1 &&
			hero.Mana >= jump.ManaCost
		const nimbusCost = nimbus && nimbus.ManaCost > 0 ? nimbus.ManaCost : 325
		const isNimbusReady =
			nimbus && this.ksSkillsSelector.IsEnabled("zuus_cloud") && nimbus.Cooldown <= 0.1 && hero.Mana >= nimbusCost
		const isWrathReady =
			wrath &&
			this.ksSkillsSelector.IsEnabled("zuus_thundergods_wrath") &&
			wrath.IsValid &&
			wrath.Level > 0 &&
			wrath.Cooldown <= 0.1 &&
			hero.Mana >= wrath.ManaCost

		// Items for KS
		const dagon = this.getDagonItem(hero)
		const isDagonReady =
			dagon &&
			this.ksItemsSelector.IsEnabled("item_dagon") &&
			dagon.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= dagon.ManaCost
		const eblade = hero.Items.find(i => i.Name === "item_ethereal_blade")
		const isEbladeReady =
			eblade &&
			this.ksItemsSelector.IsEnabled("item_ethereal_blade") &&
			eblade.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= eblade.ManaCost
		const shiva = hero.Items.find(i => i.Name === "item_shivas_guard")
		const isShivaReady =
			shiva &&
			this.ksItemsSelector.IsEnabled("item_shivas_guard") &&
			shiva.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= shiva.ManaCost
		const veil = hero.Items.find(i => i.Name === "item_veil_of_discord")
		const isVeilReady =
			veil &&
			this.ksItemsSelector.IsEnabled("item_veil_of_discord") &&
			veil.Cooldown <= 0.1 &&
			!hero.IsMuted &&
			hero.Mana >= veil.ManaCost

		const enemies = EntityManager.GetEntitiesByClass(Hero).filter(
			e => e.IsValid && e.IsAlive && e.IsEnemy(hero) && !e.IsIllusion && !this.isImmuneOrInvulnerable(e)
		)

		// 1. Single Spell / Item Kill Steal
		for (const enemy of enemies) {
			if (!enemy.IsVisible) {
				continue
			}

			// If enemy is already inside an active Nimbus strike, do not waste more spells
			if (this.isEnemyUnderActiveNimbus(enemy)) {
				continue
			}

			const dist = hero.Distance2D(enemy)

			// 1a. Arc Lightning (Q) KS (Lowest mana & short CD)
			if (isArcReady && arc && dist <= (arc.CastRange > 0 ? arc.CastRange : 850) + 100) {
				const damage = this.getEffectiveDamage(hero, enemy, this.getArcDamage(hero, enemy))
				if (enemy.HP <= damage) {
					this.castTarget(hero, arc, enemy)
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + arc.CastPoint * 1000 + 100)
					return true
				}
			}

			// 1b. Lightning Bolt (W) KS
			if (isBoltReady && bolt && dist <= (bolt.CastRange > 0 ? bolt.CastRange : 700) + 100) {
				const damage = this.getEffectiveDamage(hero, enemy, this.getBoltDamage(hero, enemy))
				if (enemy.HP <= damage) {
					this.castTarget(hero, bolt, enemy)
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + bolt.CastPoint * 1000 + 100)
					return true
				}
			}

			// 1c. Heavenly Jump (E) KS
			if (isJumpReady && jump && dist <= 700) {
				const damage = this.getEffectiveDamage(hero, enemy, this.getJumpDamage(hero, enemy))
				if (enemy.HP <= damage) {
					this.castNoTarget(hero, jump)
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + jump.CastPoint * 1000 + 100)
					return true
				}
			}

			// 1d. Dagon KS
			if (isDagonReady && dagon && dist <= (dagon.CastRange || 700)) {
				const rawDamage = this.getItemDamage(dagon, hero)
				const damage = this.getEffectiveDamage(hero, enemy, rawDamage)
				if (enemy.HP <= damage) {
					this.castTarget(hero, dagon, enemy)
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 1e. Ethereal Blade KS
			if (isEbladeReady && eblade && dist <= (eblade.CastRange || 800)) {
				const rawDamage = this.getEbladeDamage(eblade, hero)
				const damage = this.getEffectiveDamage(hero, enemy, rawDamage)
				if (enemy.HP <= damage) {
					this.castTarget(hero, eblade, enemy)
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 1f. Shiva's Guard KS
			if (isShivaReady && shiva && dist <= 900) {
				const rawDamage = shiva.GetSpecialValue("blast_damage") || 200
				const damage = this.getEffectiveDamage(hero, enemy, rawDamage)
				if (enemy.HP <= damage) {
					this.castNoTarget(hero, shiva)
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + 100)
					return true
				}
			}

			// 1g. Nimbus (Aghs Cloud) KS (When prioritized over Wrath)
			if (
				this.ksGlobalPriority.SelectedID === 0 &&
				isNimbusReady &&
				nimbus &&
				(!this.ksAntiOverkill.value || GameState.RawGameTime - this.lastWrathCastTime >= 2.0)
			) {
				const rawDamage = this.getNimbusDamage(hero, enemy)
				const damage = this.getEffectiveDamage(hero, enemy, rawDamage)
				if (enemy.HP <= damage) {
					this.castPosition(hero, nimbus, enemy.Position)
					this.activeNimbusCastList.push({
						position: enemy.Position.Clone(),
						expireTime: GameState.RawGameTime + 3.0,
						targetIndex: enemy.Index
					})
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 400)
					return true
				}
			}
		}

		// 2. Multi-Spell / Item Combo Kill Steal
		if (this.ksComboKill.value) {
			for (const enemy of enemies) {
				if (!enemy.IsVisible || this.isEnemyUnderActiveNimbus(enemy)) {
					continue
				}

				const dist = hero.Distance2D(enemy)

				// Combo A: E-Blade + Dagon
				if (isEbladeReady && isDagonReady && eblade && dagon && dist <= 700) {
					const ebladeRaw = this.getEbladeDamage(eblade, hero)
					const dagonRaw = this.getItemDamage(dagon, hero)
					const totalRaw = (ebladeRaw + dagonRaw) * 1.4 // E-Blade 40% magic amp
					const totalDmg = this.getEffectiveDamage(hero, enemy, totalRaw)

					if (enemy.HP <= totalDmg && hero.Mana >= eblade.ManaCost + dagon.ManaCost) {
						this.castTarget(hero, eblade, enemy)
						this.castTarget(hero, dagon, enemy)
						this.ksSleeper.Sleep(GameState.InputLag * 1000 + 200)
						return true
					}
				}

				// Combo B: E-Blade + Lightning Bolt
				if (isEbladeReady && isBoltReady && eblade && bolt && dist <= 700) {
					const ebladeRaw = this.getEbladeDamage(eblade, hero)
					const boltRaw = this.getBoltDamage(hero, enemy)
					const totalRaw = (ebladeRaw + boltRaw) * 1.4
					const totalDmg = this.getEffectiveDamage(hero, enemy, totalRaw)

					if (enemy.HP <= totalDmg && hero.Mana >= eblade.ManaCost + bolt.ManaCost) {
						this.castTarget(hero, eblade, enemy)
						this.castTarget(hero, bolt, enemy)
						this.ksSleeper.Sleep(GameState.InputLag * 1000 + bolt.CastPoint * 1000 + 150)
						return true
					}
				}

				// Combo C: Veil + Lightning Bolt
				if (isVeilReady && isBoltReady && veil && bolt && dist <= 700) {
					const boltRaw = this.getBoltDamage(hero, enemy) * 1.18
					const totalDmg = this.getEffectiveDamage(hero, enemy, boltRaw)

					if (enemy.HP <= totalDmg && hero.Mana >= veil.ManaCost + bolt.ManaCost) {
						if (veil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
							this.castTarget(hero, veil, enemy)
						} else {
							this.castNoTarget(hero, veil)
						}
						this.castTarget(hero, bolt, enemy)
						this.ksSleeper.Sleep(GameState.InputLag * 1000 + bolt.CastPoint * 1000 + 150)
						return true
					}
				}

				// Combo D: Bolt + Arc Lightning
				if (isBoltReady && isArcReady && bolt && arc && dist <= 700) {
					const totalRaw = this.getBoltDamage(hero, enemy) + this.getArcDamage(hero, enemy)
					const totalDmg = this.getEffectiveDamage(hero, enemy, totalRaw)

					if (enemy.HP <= totalDmg && hero.Mana >= bolt.ManaCost + arc.ManaCost) {
						this.castTarget(hero, bolt, enemy)
						this.castTarget(hero, arc, enemy)
						this.ksSleeper.Sleep(GameState.InputLag * 1000 + bolt.CastPoint * 1000 + 200)
						return true
					}
				}
			}
		}

		// 3. Thundergod's Wrath (R) Global KS
		// @ts-ignore
		const isManualWrathPressed = this.ksWrathCustomKey.isPressed
		if (
			isWrathReady &&
			wrath &&
			(this.ksSkillsSelector.IsEnabled("zuus_thundergods_wrath") || isManualWrathPressed)
		) {
			let killableCount = 0
			const allEnemies = EntityManager.GetEntitiesByClass(Hero).filter(
				e =>
					e.IsValid &&
					e.IsAlive &&
					e.IsEnemy(hero) &&
					!e.IsIllusion &&
					!this.isImmuneOrInvulnerable(e) &&
					(this.ksWrathCheckInvisible.value || e.IsVisible)
			)

			for (const enemy of allEnemies) {
				// Anti-overkill check: if this enemy is already taking lethal damage from an active Nimbus, do not count towards Wrath
				if (this.isEnemyUnderActiveNimbus(enemy)) {
					continue
				}

				const damage = this.getEffectiveDamage(hero, enemy, this.getWrathDamage(hero, enemy))
				if (enemy.HP <= damage) {
					killableCount++
				}
			}

			if (killableCount >= this.ksWrathMinEnemies.value || (isManualWrathPressed && killableCount > 0)) {
				this.castNoTarget(hero, wrath)
				this.lastWrathCastTime = GameState.RawGameTime
				this.ksSleeper.Sleep(GameState.InputLag * 1000 + wrath.CastPoint * 1000 + 500)
				return true
			}
		}

		// 4. Nimbus (Aghs Cloud) KS (When prioritized after Wrath or when Wrath was not enough)
		if (
			this.ksGlobalPriority.SelectedID === 1 &&
			isNimbusReady &&
			nimbus &&
			(!this.ksAntiOverkill.value || GameState.RawGameTime - this.lastWrathCastTime >= 2.0)
		) {
			for (const enemy of enemies) {
				if (!enemy.IsVisible || this.isEnemyUnderActiveNimbus(enemy)) {
					continue
				}
				const rawDamage = this.getNimbusDamage(hero, enemy)
				const damage = this.getEffectiveDamage(hero, enemy, rawDamage)
				if (enemy.HP <= damage) {
					this.castPosition(hero, nimbus, enemy.Position)
					this.activeNimbusCastList.push({
						position: enemy.Position.Clone(),
						expireTime: GameState.RawGameTime + 3.0,
						targetIndex: enemy.Index
					})
					this.ksSleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 400)
					return true
				}
			}
		}

		return false
	}

	// ==========================================
	// AUTO NIMBUS CHANNELING & TELEPORT INTERRUPTER
	// ==========================================

	private handleNimbusInterrupter(hero: Hero): boolean {
		const nimbus = this.getNimbusAbility(hero)
		const nimbusCost = nimbus && nimbus.ManaCost > 0 ? nimbus.ManaCost : 325
		if (!nimbus || nimbus.Cooldown > 0.1 || hero.Mana < nimbusCost) {
			return false
		}

		const enemies = EntityManager.GetEntitiesByClass(Hero).filter(
			e => e.IsValid && e.IsAlive && e.IsEnemy(hero) && !e.IsIllusion
		)

		for (const enemy of enemies) {
			if (this.isSpellImmuneOrUninterruptible(enemy)) {
				continue
			}

			// Check if enemy has teleporting or portal warp modifier
			const hasTpBuff = enemy.Buffs.some(
				b =>
					b.Name === "modifier_teleporting" ||
					b.Name === "modifier_teleporting_tinker" ||
					b.Name === "modifier_furion_teleport_shield"
			)
			const isTp = hasTpBuff || (enemy.TPStartPosition && enemy.TPStartPosition.IsValid)
			const isTwinGate = enemy.Buffs.some(b => b.Name === "modifier_twin_gate_portal_warp")
			const isChannelingSpell = enemy.IsChanneling && !isTp && !isTwinGate

			if (!isTp && !isTwinGate && !isChannelingSpell) {
				continue
			}

			// Determine exact cast position (use TPStartPosition if available for 100% accuracy)
			const castPos =
				enemy.TPStartPosition && enemy.TPStartPosition.IsValid ? enemy.TPStartPosition : enemy.Position

			if (!castPos || !castPos.IsValid) {
				continue
			}

			// 1. Fog of War Teleport Interrupt
			if (!enemy.IsVisible) {
				if ((isTp || enemy.IsChanneling) && this.nimbusInterruptFogTeleport.value) {
					this.castPosition(hero, nimbus, castPos)
					this.activeNimbusCastList.push({
						position: castPos.Clone(),
						expireTime: GameState.RawGameTime + 3.0,
						targetIndex: enemy.Index
					})
					this.interrupterSleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 250)
					return true
				}
				continue
			}

			// 2. Visible Teleport Interrupt
			if (isTp && this.nimbusInterruptTeleport.value) {
				this.castPosition(hero, nimbus, castPos)
				this.activeNimbusCastList.push({
					position: castPos.Clone(),
					expireTime: GameState.RawGameTime + 3.0,
					targetIndex: enemy.Index
				})
				this.interrupterSleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 250)
				return true
			}

			// 3. Visible Twin Gate Interrupt
			if (isTwinGate && this.nimbusInterruptTwinGate.value) {
				this.castPosition(hero, nimbus, castPos)
				this.activeNimbusCastList.push({
					position: castPos.Clone(),
					expireTime: GameState.RawGameTime + 3.0,
					targetIndex: enemy.Index
				})
				this.interrupterSleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 250)
				return true
			}

			// 4. Visible Channeling Spells Interrupt (Black Hole, Death Ward, Freezing Field, etc.)
			if (isChannelingSpell && this.nimbusInterruptSpells.value) {
				this.castPosition(hero, nimbus, castPos)
				this.activeNimbusCastList.push({
					position: castPos.Clone(),
					expireTime: GameState.RawGameTime + 3.0,
					targetIndex: enemy.Index
				})
				this.interrupterSleeper.Sleep(GameState.InputLag * 1000 + nimbus.CastPoint * 1000 + 250)
				return true
			}
		}

		return false
	}

	// ==========================================
	// DEFENSIVE HEAVENLY JUMP
	// ==========================================

	private handleDefensiveJump(hero: Hero): boolean {
		const jump = hero.GetAbilityByName("zuus_heavenly_jump")
		if (!jump || !jump.IsValid || jump.Level === 0 || jump.Cooldown > 0.1 || hero.Mana < jump.ManaCost) {
			return false
		}

		const heroHpPct = (hero.HP / hero.MaxHP) * 100
		if (heroHpPct > this.autoJumpHpThreshold.value) {
			return false
		}

		const triggerRange = this.autoJumpEnemyRange.value
		const nearbyEnemy = EntityManager.GetEntitiesByClass(Hero).find(
			e =>
				e.IsValid &&
				e.IsAlive &&
				e.IsVisible &&
				e.IsEnemy(hero) &&
				!e.IsIllusion &&
				hero.Distance2D(e) <= triggerRange
		)

		if (nearbyEnemy) {
			this.castNoTarget(hero, jump)
			this.autoJumpSleeper.Sleep(GameState.InputLag * 1000 + jump.CastPoint * 1000 + 300)
			return true
		}

		return false
	}

	// ==========================================
	// AUTO ARC (Q) HARASS / FARM
	// ==========================================

	private handleAutoQ(hero: Hero): boolean {
		const arc = hero.GetAbilityByName("zuus_arc_lightning")
		if (!arc || !arc.IsValid || arc.Level === 0 || arc.Cooldown > 0.1 || hero.Mana < arc.ManaCost) {
			return false
		}

		const manaPct = (hero.Mana / hero.MaxMana) * 100
		if (manaPct < this.autoQMinManaPct.value) {
			return false
		}

		const arcRange = (arc.CastRange > 0 ? arc.CastRange : 850) + 100
		const mode = this.autoQMode.SelectedID

		// Mode 1: Check lowest HP creep to secure last hit
		if (mode === 1) {
			const creeps = EntityManager.GetEntitiesByClass(Creep).filter(
				c => c.IsValid && c.IsAlive && c.IsVisible && c.IsEnemy(hero) && hero.Distance2D(c) <= arcRange
			)

			for (const creep of creeps) {
				const damage = this.getEffectiveDamage(hero, creep, arc.GetRawDamage(creep))
				if (creep.HP <= damage) {
					this.castTarget(hero, arc, creep)
					this.autoQSleeper.Sleep(GameState.InputLag * 1000 + arc.CastPoint * 1000 + 150)
					return true
				}
			}
		}

		// Harass closest enemy hero
		const targetHero = EntityManager.GetEntitiesByClass(Hero).find(
			e =>
				e.IsValid &&
				e.IsAlive &&
				e.IsVisible &&
				e.IsEnemy(hero) &&
				!e.IsIllusion &&
				hero.Distance2D(e) <= arcRange
		)

		if (targetHero && !this.isImmuneOrInvulnerable(targetHero)) {
			this.castTarget(hero, arc, targetHero)
			this.autoQSleeper.Sleep(GameState.InputLag * 1000 + arc.CastPoint * 1000 + 150)
			return true
		}

		return false
	}

	// ==========================================
	// TARGETING & DAMAGE UTILITIES
	// ==========================================

	private getTarget(hero: Hero): Hero | undefined {
		if (this.lockTargetEnabled.value && this.lockedTarget) {
			if (
				!this.lockedTarget.IsValid ||
				!this.lockedTarget.IsAlive ||
				!this.lockedTarget.IsVisible ||
				this.lockedTarget.IsIllusion
			) {
				this.lockedTarget = undefined
			} else {
				return this.lockedTarget
			}
		}

		const mousePos = InputManager.CursorOnWorld
		const radius = this.comboRadius.value
		let best: Hero | undefined
		let minDist = Infinity

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
				const distToMouse = enemy.Position.Distance2D(mousePos)
				if (distToMouse <= radius && distToMouse < minDist) {
					minDist = distToMouse
					best = enemy
				}
			}
		}

		if (this.lockTargetEnabled.value && best) {
			this.lockedTarget = best
		}

		return best
	}

	/**
	 * Specifically checks if the target is debuff immune or invulnerable to stuns/interrupts.
	 * Notice: does NOT block on fountain aura when cancelling teleports.
	 */
	private isSpellImmuneOrUninterruptible(target: Hero): boolean {
		if (!target.IsValid || !target.IsAlive) {
			return true
		}

		if (target.IsDebuffImmune || target.IsMagicImmune) {
			return true
		}

		const uninterruptibleBuffs = [
			"modifier_black_king_bar",
			"modifier_eul_cyclone",
			"modifier_wind_waker",
			"modifier_shadow_demon_disruption",
			"modifier_obsidian_destroyer_astral_imprisonment_prison",
			"modifier_brewmaster_primal_split"
		]

		return target.Buffs.some(buff => uninterruptibleBuffs.includes(buff.Name))
	}

	private isImmuneOrInvulnerable(target: Hero): boolean {
		if (!target.IsValid || !target.IsAlive || target.IsMagicImmune || target.IsInvulnerable) {
			return true
		}

		if (this.ksCheckBladeMail.value) {
			if (
				target.Buffs.some(
					buff =>
						buff.Name === "modifier_item_blade_mail_reflect" ||
						buff.Name === "modifier_item_lotus_orb_active"
				)
			) {
				return true
			}
		}

		const immuneBuffNames = [
			"modifier_fountain_invulnerability",
			"modifier_eul_cyclone",
			"modifier_wind_waker",
			"modifier_dazzle_shallow_grave",
			"modifier_abaddon_borrowed_time",
			"modifier_item_aeon_disk_buff",
			"modifier_oracle_false_promise_timer",
			"modifier_brewmaster_primal_split",
			"modifier_shadow_demon_disruption",
			"modifier_obsidian_destroyer_astral_imprisonment_prison"
		]

		return target.Buffs.some(buff => immuneBuffNames.includes(buff.Name))
	}

	private getEffectiveDamage(caster: Hero, target: Unit, rawDamage: number): number {
		if (target instanceof Hero && this.isImmuneOrInvulnerable(target)) {
			return 0
		}
		const amp = target.GetDamageAmplification(caster, DAMAGE_TYPES.DAMAGE_TYPE_MAGICAL, 0, false, false, rawDamage)
		return Math.max(0, rawDamage * amp)
	}

	private getDagonItem(hero: Hero): Item | undefined {
		for (const name of ["item_dagon_5", "item_dagon_4", "item_dagon_3", "item_dagon_2", "item_dagon"]) {
			const item = hero.Items.find(i => i.Name === name)
			if (item && item.IsValid) {
				return item
			}
		}
		return undefined
	}

	private getItemDamage(item: Item, _hero: Hero): number {
		return item.GetBaseDamageForLevel(item.Level) || item.GetSpecialValue("damage") || 400
	}

	private getEbladeDamage(eblade: Item, hero: Hero): number {
		const base = eblade.GetBaseDamageForLevel(eblade.Level) || 50
		const attrMult = eblade.GetSpecialValue("blast_damage_attribute") || 1.5
		return base + attrMult * hero.TotalIntellect
	}

	private getSortedSpells(): string[] {
		const enabledSpells = COMBO_SPELLS.filter(name => this.comboSequenceGrid.IsEnabled(name))
		return enabledSpells.sort((a, b) => {
			const prioA = this.comboSequenceGrid.GetPriority(a) ?? 999
			const prioB = this.comboSequenceGrid.GetPriority(b) ?? 999
			return prioA - prioB
		})
	}

	// ==========================================
	// CAST ORDERS
	// ==========================================

	private castNoTarget(issuer: Hero, ability: Ability | Item): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
			issuers: [issuer],
			ability: ability.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private castTarget(issuer: Hero, ability: Ability | Item, target: Unit): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
			issuers: [issuer],
			target: target.Index,
			ability: ability.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
	}

	private castPosition(issuer: Hero, ability: Ability | Item, pos: Vector3): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
			issuers: [issuer],
			position: pos,
			ability: ability.Index,
			queue: false,
			showEffects: true,
			isPlayerInput: false
		})
	}

	// ==========================================
	// DRAW & HUD OVERLAYS
	// ==========================================

	private Draw(): void {
		if (ExecuteOrder.DisableHumanizer || !this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// 1. Target Circle & Range Indicator
		if (this.showTargetCircle.value) {
			const target = this.lockedTarget || this.getTarget(hero)
			if (target && target.IsValid && target.IsAlive && target.IsVisible) {
				const screenPos = RendererSDK.WorldToScreen(target.Position)
				if (screenPos) {
					RendererSDK.OutlinedCircle(screenPos, new Vector2(45, 45), new Color(0, 200, 255, 220), 2)
				}
			}
		}

		// 2. Killable Enemies HUD
		if (this.showKillableHUD.value) {
			this.drawKillableHUD(hero)
		}

		// 3. Draggable Status HUD
		if (this.showStatusHUD.value) {
			this.drawStatusHUD()
		}
	}

	private drawKillableHUD(hero: Hero): void {
		const wrath = hero.GetAbilityByName("zuus_thundergods_wrath")
		const bolt = hero.GetAbilityByName("zuus_lightning_bolt")
		const arc = hero.GetAbilityByName("zuus_arc_lightning")
		const nimbus = this.getNimbusAbility(hero)

		const isWrathReady =
			wrath && wrath.IsValid && wrath.Level > 0 && wrath.Cooldown <= 0.1 && hero.Mana >= wrath.ManaCost
		const isBoltReady = bolt && bolt.IsValid && bolt.Level > 0 && bolt.Cooldown <= 0.1 && hero.Mana >= bolt.ManaCost
		const isArcReady = arc && arc.IsValid && arc.Level > 0 && arc.Cooldown <= 0.1 && hero.Mana >= arc.ManaCost
		const nimbusCost = nimbus && nimbus.ManaCost > 0 ? nimbus.ManaCost : 325
		const isNimbusReady = nimbus && nimbus.Cooldown <= 0.1 && hero.Mana >= nimbusCost

		const enemies = EntityManager.GetEntitiesByClass(Hero).filter(
			e => e.IsValid && e.IsAlive && e.IsEnemy(hero) && !e.IsIllusion
		)

		let yOffset = 180
		for (const enemy of enemies) {
			const wrathDmg = this.getEffectiveDamage(hero, enemy, this.getWrathDamage(hero, enemy))
			const boltDmg = this.getEffectiveDamage(hero, enemy, this.getBoltDamage(hero, enemy))
			const arcDmg = this.getEffectiveDamage(hero, enemy, this.getArcDamage(hero, enemy))
			const nimbusDmg = this.getEffectiveDamage(hero, enemy, this.getNimbusDamage(hero, enemy))

			const canWrathKill = isWrathReady && enemy.HP <= wrathDmg
			const canNimbusKill = isNimbusReady && enemy.HP <= nimbusDmg
			const canBoltKill = isBoltReady && enemy.HP <= boltDmg
			const canArcKill = isArcReady && enemy.HP <= arcDmg

			if (canWrathKill || canNimbusKill || canBoltKill || canArcKill) {
				const tags: string[] = []
				if (canWrathKill) {
					tags.push("[R KILLABLE]")
				}
				if (canNimbusKill) {
					tags.push("[NIMBUS KILLABLE]")
				}
				if (canBoltKill) {
					tags.push("[W KILLABLE]")
				}
				if (canArcKill) {
					tags.push("[Q KILLABLE]")
				}

				const text = `${enemy.Name.replace("npc_dota_hero_", "")}: HP ${Math.round(enemy.HP)} | ${tags.join(
					" "
				)}`
				const color = canWrathKill
					? new Color(255, 60, 60, 255)
					: canNimbusKill
					? new Color(0, 220, 255, 255)
					: new Color(255, 215, 0, 255)

				RendererSDK.FilledRect(new Vector2(20, yOffset - 2), new Vector2(340, 22), new Color(0, 0, 0, 180))
				RendererSDK.Text(text, new Vector2(25, yOffset), color, RendererSDK.DefaultFontName, 13, 500)
				yOffset += 26
			}
		}
	}

	private drawStatusHUD(): void {
		const mouse = InputManager.CursorOnScreen
		const w = 180
		const h = 85
		const pos = this.statusHudPos

		if (InputManager.IsMouseKeyDown(VMouseKeys.MK_LBUTTON)) {
			if (
				!this.isDraggingStatus &&
				mouse.x >= pos.x &&
				mouse.x <= pos.x + w &&
				mouse.y >= pos.y &&
				mouse.y <= pos.y + h
			) {
				this.isDraggingStatus = true
			}
		} else {
			this.isDraggingStatus = false
		}

		if (this.isDraggingStatus) {
			this.statusHudPos.CopyFrom(mouse.Subtract(new Vector2(w / 2, h / 2)))
		}

		RendererSDK.FilledRect(this.statusHudPos, new Vector2(w, h), new Color(20, 24, 32, 220))
		RendererSDK.OutlinedRect(this.statusHudPos, new Vector2(w, h), 1.5, new Color(60, 120, 240, 200))

		RendererSDK.Text(
			"⚡ Zeus Combo",
			new Vector2(this.statusHudPos.x + 10, this.statusHudPos.y + 8),
			new Color(0, 220, 255, 255),
			RendererSDK.DefaultFontName,
			14,
			600
		)
		RendererSDK.Text(
			// @ts-ignore
			`Combo: [${this.comboKey.assignedKey}] ${this.comboKey.isPressed ? "ACTIVE" : "READY"}`,
			new Vector2(this.statusHudPos.x + 10, this.statusHudPos.y + 28),
			// @ts-ignore
			this.comboKey.isPressed ? new Color(50, 255, 50, 255) : new Color(200, 200, 200, 255),
			RendererSDK.DefaultFontName,
			12,
			400
		)
		RendererSDK.Text(
			`Auto KS: ${this.enableKS.value ? "ON" : "OFF"} | Interrupter: ${
				this.enableNimbusInterrupter.value ? "ON" : "OFF"
			}`,
			new Vector2(this.statusHudPos.x + 10, this.statusHudPos.y + 46),
			new Color(180, 180, 180, 255),
			RendererSDK.DefaultFontName,
			11,
			400
		)
		RendererSDK.Text(
			`Target: ${this.lockedTarget ? this.lockedTarget.Name.replace("npc_dota_hero_", "") : "None"}`,
			new Vector2(this.statusHudPos.x + 10, this.statusHudPos.y + 64),
			new Color(255, 220, 100, 255),
			RendererSDK.DefaultFontName,
			11,
			400
		)
	}
})()
