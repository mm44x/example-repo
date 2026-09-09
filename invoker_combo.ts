import {
	Ability,
	Color,
	DOTA_ABILITY_BEHAVIOR,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	ImageData,
	InputEventSDK,
	InputManager,
	Item,
	LocalPlayer,
	Menu,
	ParticleAttachment,
	ParticlesSDK,
	Rectangle,
	RendererSDK,
	TickSleeper,
	Unit,
	Vector2,
	Vector3,
	VMouseKeys
} from "github.com/octarine-public/wrapper/index"

import { claimOrder, isRealHero } from "./coordination"
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

const BIG_CC_MODIFIERS = [
	"modifier_faceless_void_chronosphere_freeze",
	"modifier_enigma_black_hole_pull",
	"modifier_magnataur_reverse_polarity",
	"modifier_magnataur_reverse_polarity_stun",
	"modifier_axe_berserkers_call",
	"modifier_treant_overgrowth",
	"modifier_winter_wyvern_winters_curse",
	"modifier_winter_wyvern_winters_curse_aura",
	"modifier_bane_fiends_grip",
	"modifier_shadow_shaman_shackles",
	"modifier_pudge_dismember",
	"modifier_tidehunter_ravage",
	"modifier_primal_beast_pulverize",
	"modifier_legion_commander_duel"
]

interface IComboTemplateInfo {
	id: number
	name: string
	tag: string
	desc: string
	startingSpells: [string, string]
	sequenceActions: string[]
}

const COMBO_TEMPLATES: IComboTemplateInfo[] = [
	{
		id: 0,
		name: "Dynamic Combo",
		tag: "DYNAMIC",
		desc: "Custom Menu Order",
		startingSpells: ["invoker_tornado", "invoker_emp"],
		sequenceActions: ["invoker_tornado", "invoker_emp", "invoker_chaos_meteor", "invoker_deafening_blast"]
	},
	{
		id: 1,
		name: "Eul One-Shot (QE)",
		tag: "EUL'S ONE-SHOT",
		desc: "QE Core (Lv 8-15)",
		startingSpells: ["invoker_sun_strike", "invoker_chaos_meteor"],
		sequenceActions: [
			"item_cyclone",
			"invoker_sun_strike",
			"invoker_chaos_meteor",
			"invoker_deafening_blast",
			"invoker_cold_snap"
		]
	},
	{
		id: 2,
		name: "Cold Snap + Urn",
		tag: "COLD SNAP + URN",
		desc: "Early Gank (Lv 3-9)",
		startingSpells: ["invoker_cold_snap", "invoker_forge_spirit"],
		sequenceActions: [
			"invoker_forge_spirit",
			"invoker_cold_snap",
			"item_urn_of_shadows",
			"item_rod_of_atos",
			"invoker_alacrity",
			"invoker_sun_strike"
		]
	},
	{
		id: 3,
		name: "Quas-Wex EMP (QW)",
		tag: "QUAS-WEX EMP",
		desc: "Disruptor (Lv 6-14)",
		startingSpells: ["invoker_tornado", "invoker_emp"],
		sequenceActions: ["invoker_tornado", "invoker_emp", "invoker_cold_snap", "item_urn_of_shadows"]
	},
	{
		id: 4,
		name: "Late Game / Refresher",
		tag: "LATE GAME",
		desc: "Full Teamfight (Lv 18+)",
		startingSpells: ["invoker_tornado", "invoker_chaos_meteor"],
		sequenceActions: [
			"item_sheepstick",
			"item_nullifier",
			"invoker_tornado",
			"invoker_chaos_meteor",
			"invoker_deafening_blast",
			"item_refresher"
		]
	}
]

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
		"Cast Cataclysm (double-tap / self-cast) instead of regular Sun Strike if Aghanim's Scepter is active"
	)

	private readonly scepterUpgrade = this.entry.AddDropdown(
		"Aghanim Scepter Upgrade Mode",
		["Exort Upgrade (Cataclysm)", "Quas Upgrade (Ice Wall Ground Target)", "Wex Upgrade / None"],
		0,
		"Select which upgrade/facet you took for Aghanim's Scepter"
	)

	private readonly itemsSelector = this.entry.AddImageSelector(
		"Use Items",
		[
			"item_blink",
			"item_cyclone",
			"item_wind_waker",
			"item_sheepstick",
			"item_rod_of_atos",
			"item_orchid",
			"item_bloodthorn",
			"item_nullifier",
			"item_urn_of_shadows",
			"item_spirit_vessel",
			"item_shivas_guard",
			"item_refresher"
		],
		new Map([
			["item_blink", true],
			["item_cyclone", true],
			["item_wind_waker", true],
			["item_sheepstick", true],
			["item_rod_of_atos", true],
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
		0,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle(
		"Stop-to-Cancel Backswing",
		false,
		"Use STOP before moving during backswing cancel for crisper animation break"
	)

	private readonly autoSwitchOrbs = this.entry.AddToggle(
		"Auto Switch Orbs in Combat",
		true,
		"Automatically switch to 3x Exort during attack/combo for maximum damage, and 3x Wex after Ghost Walk"
	)

	private readonly templatesNode = this.entry.AddNode(
		"Combo Templates & Floating HUD",
		"panorama/images/hud/reborn/icon_inventory_png.vtex_c"
	)
	private readonly activeTemplateDropdown = this.templatesNode.AddDropdown(
		"Active Template",
		COMBO_TEMPLATES.map(t => t.name),
		0,
		"Select active combo template. Can also be selected via on-screen Floating HUD Panel"
	)
	private readonly autoPrepareSpells = this.templatesNode.AddToggle(
		"Auto Prepare Starting Spells",
		true,
		"Automatically invoke the 2 starting spells when switching templates"
	)
	private readonly floatingHudNode = this.templatesNode.AddNode("Floating HUD Settings")
	private readonly floatingHudEnabled = this.floatingHudNode.AddToggle("Show Floating HUD Panel", true)
	private readonly floatingHudKey = this.floatingHudNode.AddKeybind(
		"Toggle HUD Key",
		"None",
		"Key to toggle on-screen Floating HUD Panel visibility"
	)
	private readonly floatingHudX = this.floatingHudNode.AddSlider("HUD Position X", 350, 0, 2500)
	private readonly floatingHudY = this.floatingHudNode.AddSlider("HUD Position Y", 180, 0, 2500)

	private isDraggingHud = false
	private dragOffsetX = 0
	private dragOffsetY = 0
	private pendingPrepareSpells: string[] = []

	private readonly pSDK = new ParticlesSDK()
	private comboSequenceGrid: any
	private lockedTarget: Hero | undefined = undefined
	private readonly sleeper = new TickSleeper()

	private disruptNode: any = null
	private enableDisrupt: any = null
	private disruptSkills: any = null
	private disruptInvis: any = null

	private sunstrikeNode: any = null
	private enableSunstrike: any = null
	private sunstrikeOnStun: any = null
	private sunstrikeOnWalk: any = null
	private sunstrikeInvis: any = null
	private sunstrikeHPThreshold: any = null

	private autoCataclysmNode: any = null
	private enableAutoCataclysm: any = null
	private cataclysmMinStunned: any = null
	private cataclysmOnBigUlts: any = null
	private cataclysmMinBigUlts: any = null
	private cataclysmAutoInvoke: any = null
	private cataclysmInvis: any = null
	private pendingAutoCataclysm = false

	private autoSkillNode: any = null
	private autoSkillConfigs: Map<string, { key: any; mode: any }> = new Map()
	private pendingAutoSkill: string | null = null
	private autoSkillCursorPos: Vector3 | null = null
	private pendingSunstrikePos: Vector3 | null = null
	private lastCataclysmCast = 0

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
			"Combo Order (Dynamic Combo)",
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
			const spellNode = this.autoSkillNode.AddNode(displayName, icon, "", 0)
			const hotkey = spellNode.AddKeybind("Hotkey", "", `Hotkey to trigger ${displayName}`)
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

		// Auto Sunstrike
		this.sunstrikeNode = this.entry.AddNode(
			"Auto Sunstrike",
			"panorama/images/spellicons/invoker_sun_strike_png.vtex_c",
			"",
			0
		)
		this.enableSunstrike = this.sunstrikeNode.AddToggle(
			"Enable Auto Sunstrike",
			true,
			"Auto cast Sunstrike on stunned/channeled enemies or predicted walking low-HP enemies"
		)
		this.sunstrikeOnStun = this.sunstrikeNode.AddToggle(
			"Sunstrike on Stunned/Channeled",
			true,
			"Cast Sunstrike on enemies that are stunned or channeling (outside Cold Snap/Tornado range)"
		)
		this.sunstrikeOnWalk = this.sunstrikeNode.AddToggle(
			"Sunstrike Walking Prediction",
			true,
			"Predict enemy movement and Sunstrike if they're low enough to kill"
		)
		this.sunstrikeHPThreshold = this.sunstrikeNode.AddSlider(
			"Walking Kill HP Threshold %",
			25,
			1,
			60,
			1,
			"Only Sunstrike walking enemies whose HP is below this percentage for a potential kill"
		)
		this.sunstrikeInvis = this.sunstrikeNode.AddToggle(
			"Sunstrike in Invis",
			false,
			"Allow auto Sunstrike while Invoker is invisible (Ghost Walk, Shadow Blade, etc.)"
		)

		// Auto Cataclysm
		this.autoCataclysmNode = this.entry.AddNode(
			"Auto Cataclysm",
			"panorama/images/spellicons/invoker_sun_strike_png.vtex_c",
			"",
			0
		)
		this.enableAutoCataclysm = this.autoCataclysmNode.AddToggle(
			"Enable Auto Cataclysm",
			true,
			"Automatically cast Cataclysm when enough enemies are stunned/disabled or trapped in big ultimates"
		)
		this.cataclysmMinStunned = this.autoCataclysmNode.AddSlider(
			"Min Stunned / Rooted Enemies",
			2,
			1,
			5,
			1,
			"Minimum number of stunned or rooted enemies on the map to trigger Cataclysm"
		)
		this.cataclysmOnBigUlts = this.autoCataclysmNode.AddToggle(
			"Trigger on Major Teamfight Disables",
			true,
			"Auto-cast Cataclysm if enemies are caught in Chronosphere, Black Hole, Reverse Polarity, etc."
		)
		this.cataclysmMinBigUlts = this.autoCataclysmNode.AddSlider(
			"Min Enemies in Major Disables",
			1,
			1,
			5,
			1,
			"Minimum number of enemies caught in major crowd control to trigger Cataclysm"
		)
		this.cataclysmAutoInvoke = this.autoCataclysmNode.AddToggle(
			"Auto-Invoke for Cataclysm",
			true,
			"Automatically invoke Sun Strike if it is not currently in slot D/F when Cataclysm conditions are met"
		)
		this.cataclysmInvis = this.autoCataclysmNode.AddToggle(
			"Allow Cataclysm in Invis",
			false,
			"Allow auto Cataclysm while Invoker is invisible (Ghost Walk, Shadow Blade, etc.)"
		)

		this.activeTemplateDropdown.OnValue(() => {
			if (this.hasLocalHero && this.autoPrepareSpells.value) {
				const hero = LocalPlayer?.Hero
				if (hero && hero.IsValid && hero.IsAlive) {
					this.triggerAutoPrepare(hero, this.activeTemplateDropdown.SelectedID)
				}
			}
		})

		this.floatingHudKey.OnPressed(() => {
			this.floatingHudEnabled.value = !this.floatingHudEnabled.value
			Menu.Base.SaveConfigASAP = true
		})

		EventsSDK.on("Draw", this.OnDraw.bind(this))
		InputEventSDK.on("MouseKeyDown", this.OnMouseKeyDown.bind(this))
		InputEventSDK.on("MouseKeyUp", this.OnMouseKeyUp.bind(this))
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
		EventsSDK.on("GameStarted", this.onGameEnded.bind(this))
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
			hero.HasScepter ||
			hero.HasItemInInventory("item_ultimate_scepter") ||
			hero.HasItemInInventory("item_ultimate_scepter_2") ||
			hero.HasItemInInventory("item_ultimate_scepter_roshan") ||
			hero.HasBuffByName("modifier_item_ultimate_scepter_consumed") ||
			hero.HasBuffByName("modifier_item_ultimate_scepter_consumed_alchemist") ||
			hero.HasBuffByName("modifier_item_ultimate_scepter")
		)
	}

	private getActiveIceWallAbility(hero: Hero): Ability | undefined {
		const ad = hero.GetAbilityByName("invoker_ice_wall_ad")
		if (ad && ad.IsValid && !ad.IsHidden) {
			return ad
		}
		const base = hero.GetAbilityByName("invoker_ice_wall")
		return base && base.IsValid ? base : undefined
	}

	private isIceWallUpgraded(hero: Hero): boolean {
		if (this.scepterUpgrade.SelectedID === 1 && this.hasScepter(hero)) {
			return true
		}
		const ad = hero.GetAbilityByName("invoker_ice_wall_ad")
		return ad !== undefined && ad.IsValid && !ad.IsHidden && ad.Level > 0
	}

	private isSunStrikeUpgraded(hero: Hero): boolean {
		return this.hasScepter(hero) && this.scepterUpgrade.SelectedID === 0
	}

	private isIceWallName(name: string): boolean {
		return name === "invoker_ice_wall" || name === "invoker_ice_wall_ad"
	}

	private angleDifference(a: number, b: number): number {
		let diff = a - b
		while (diff < -Math.PI) {
			diff += Math.PI * 2
		}
		while (diff > Math.PI) {
			diff -= Math.PI * 2
		}
		return diff
	}

	// Ice Floe (Quas Aghanim) is vector targeted: first click = center, drag = direction of the floe trail
	private getIceWallCastPoints(hero: Hero, target: Hero): { origin: Vector3; end: Vector3 } {
		const floeDelay = 1.3
		const trailLength = 600

		// Predict where the target will be when the floe forms
		let origin = target.Position.Clone()
		if (target.IsMoving) {
			const speed = target.MoveSpeed > 0 ? target.MoveSpeed : 350
			origin = origin.Add(target.Forward.MultiplyScalar(speed * floeDelay))
		}

		const direction = target.IsMoving ? target.Forward.Clone() : origin.Subtract(hero.Position).Normalize()

		const end = origin.Add(direction.MultiplyScalar(trailLength))
		return { origin, end }
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
			claimOrder()
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
			claimOrder()
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
			claimOrder()
			return true
		}
		return false
	}

	private isItemEnabledForCombo(itemName: string, templateId: number): boolean {
		if (templateId === 0) {
			if (
				itemName === "item_arcane_blink" ||
				itemName === "item_overwhelming_blink" ||
				itemName === "item_swift_blink"
			) {
				return this.itemsSelector.IsEnabled("item_blink")
			}
			if (itemName === "item_wind_waker") {
				return this.itemsSelector.IsEnabled("item_wind_waker") || this.itemsSelector.IsEnabled("item_cyclone")
			}
			if (itemName === "item_gungir") {
				return this.itemsSelector.IsEnabled("item_rod_of_atos")
			}
			if (itemName === "item_bloodthorn") {
				return this.itemsSelector.IsEnabled("item_bloodthorn") || this.itemsSelector.IsEnabled("item_orchid")
			}
			if (itemName === "item_spirit_vessel") {
				return (
					this.itemsSelector.IsEnabled("item_spirit_vessel") ||
					this.itemsSelector.IsEnabled("item_urn_of_shadows")
				)
			}
			if (itemName === "item_refresher_shard") {
				return this.itemsSelector.IsEnabled("item_refresher")
			}
			return this.itemsSelector.IsEnabled(itemName)
		}

		// Preset templates ignore menu item toggles
		switch (templateId) {
			case 1: // Eul One-Shot
				return (
					itemName === "item_cyclone" ||
					itemName === "item_wind_waker" ||
					itemName === "item_blink" ||
					itemName === "item_arcane_blink" ||
					itemName === "item_overwhelming_blink" ||
					itemName === "item_swift_blink" ||
					itemName === "item_urn_of_shadows" ||
					itemName === "item_spirit_vessel"
				)
			case 2: // Cold Snap + Urn
				return (
					itemName === "item_urn_of_shadows" ||
					itemName === "item_spirit_vessel" ||
					itemName === "item_rod_of_atos" ||
					itemName === "item_gungir" ||
					itemName === "item_blink" ||
					itemName === "item_arcane_blink" ||
					itemName === "item_overwhelming_blink" ||
					itemName === "item_swift_blink"
				)
			case 3: // Quas-Wex EMP
				return (
					itemName === "item_urn_of_shadows" ||
					itemName === "item_spirit_vessel" ||
					itemName === "item_rod_of_atos" ||
					itemName === "item_gungir" ||
					itemName === "item_orchid" ||
					itemName === "item_bloodthorn" ||
					itemName === "item_blink" ||
					itemName === "item_arcane_blink" ||
					itemName === "item_overwhelming_blink" ||
					itemName === "item_swift_blink"
				)
			case 4: // Late Game / Refresher
				return (
					itemName === "item_sheepstick" ||
					itemName === "item_nullifier" ||
					itemName === "item_orchid" ||
					itemName === "item_bloodthorn" ||
					itemName === "item_rod_of_atos" ||
					itemName === "item_gungir" ||
					itemName === "item_shivas_guard" ||
					itemName === "item_refresher" ||
					itemName === "item_refresher_shard" ||
					itemName === "item_blink" ||
					itemName === "item_arcane_blink" ||
					itemName === "item_overwhelming_blink" ||
					itemName === "item_swift_blink" ||
					itemName === "item_urn_of_shadows" ||
					itemName === "item_spirit_vessel"
				)
			default:
				return false
		}
	}

	private useTargetItem(hero: Hero, itemName: string, target: Hero | Unit, templateId: number): boolean {
		if (!this.isItemEnabledForCombo(itemName, templateId)) {
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
			claimOrder()
			return true
		}
		return false
	}

	private useNoTargetItem(hero: Hero, itemName: string, templateId: number): boolean {
		if (!this.isItemEnabledForCombo(itemName, templateId)) {
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
			claimOrder()
			return true
		}
		return false
	}

	private getBlinkItem(hero: Hero, templateId: number): Item | undefined {
		if (!this.isItemEnabledForCombo("item_blink", templateId)) {
			return undefined
		}
		const blinkNames = ["item_blink", "item_arcane_blink", "item_overwhelming_blink", "item_swift_blink"]
		return hero.Items.find(i => blinkNames.includes(i.Name))
	}

	private getRefresherItem(hero: Hero, templateId: number): Item | undefined {
		if (!this.isItemEnabledForCombo("item_refresher", templateId)) {
			return undefined
		}
		return hero.Items.find(i => i.Name === "item_refresher" || i.Name === "item_refresher_shard")
	}

	private getAtosItem(hero: Hero, templateId: number): Item | undefined {
		if (!this.isItemEnabledForCombo("item_rod_of_atos", templateId)) {
			return undefined
		}
		return hero.Items.find(i => i.Name === "item_rod_of_atos" || i.Name === "item_gungir")
	}

	private hasSpellBlock(target: Hero): boolean {
		if (target.HasBuffByName("modifier_item_sphere_target")) {
			return true
		}
		const linken = target.GetBuffByName("modifier_item_sphere")
		if (linken && linken.Ability && linken.Ability.Cooldown <= 0.1) {
			return true
		}
		const mirror = target.GetBuffByName("modifier_item_mirror_shield")
		if (mirror && mirror.Ability && mirror.Ability.Cooldown <= 0.1) {
			return true
		}
		return false
	}

	private switchOrbs(hero: Hero, orbType: "quas" | "wex" | "exort"): void {
		if (!this.autoSwitchOrbs.value) {
			return
		}
		const orbAbility = hero.GetAbilityByName(`invoker_${orbType}`)
		if (!orbAbility || orbAbility.Level <= 0) {
			return
		}
		for (let i = 0; i < 3; i++) {
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

	private invokeSpell(hero: Hero, spellName: string, invokeAbility: Ability): boolean {
		const orbs = SPELL_ORBS[spellName]
		if (!orbs) {
			return false
		}

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
		claimOrder()

		return true
	}

	private castInvokerSpell(hero: Hero, ability: Ability, target: Hero, liftBuff: any, templateId: number): boolean {
		const name = ability.Name

		// 1. If target is lifted in the air by Tornado or Cyclone
		if (liftBuff) {
			const rem = liftBuff.RemainingTime
			const castPoint = ability.CastPoint
			const delayBuffer = GameState.InputLag

			if (name === "invoker_sun_strike" || name === "invoker_sun_strike_ad") {
				const ssDelay = 1.7
				const triggerTime = ssDelay + castPoint + delayBuffer
				if (rem <= triggerTime) {
					const wantCataclysm = this.useCataclysm.value && this.isSunStrikeUpgraded(hero)
					if (wantCataclysm) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: hero,
							position: hero.Position.Clone(),
							ability,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						claimOrder()
						this.lastCataclysmCast = GameState.RawGameTime
						console.log("[InvokerCombo] Timed Cataclysm casted (target self / double-tap)!")
						this.sleeper.Sleep(delayBuffer * 1000 + castPoint * 1000 + 150)
						return true
					}

					if (this.executeComboAbility(hero, ability, target, true, target.Position)) {
						console.log("[InvokerCombo] Timed Sun Strike casted!")
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

			if (this.isIceWallName(name) && this.isIceWallUpgraded(hero)) {
				// Ice Floe forms 1.3s after cast — time it so the trail covers the landing spot
				const triggerTime = 1.3 + castPoint + delayBuffer
				if (rem <= triggerTime) {
					const { origin, end } = this.getIceWallCastPoints(hero, target)
					hero.CastVectorTargetPosition(ability, origin, end)
					console.log("[InvokerCombo] Timed Ice Floe casted under lifted target!")
					this.sleeper.Sleep(delayBuffer * 1000 + castPoint * 1000 + 150)
					return true
				}
				return false
			}

			if (rem > 0.1) {
				return false
			}
		}

		// 2. Normal Cast (No lift buff active)
		if (name === "invoker_sun_strike" || name === "invoker_sun_strike_ad") {
			const wantCataclysm = this.useCataclysm.value && this.isSunStrikeUpgraded(hero)
			if (wantCataclysm) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: hero,
					position: hero.Position.Clone(),
					ability,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				claimOrder()
				this.lastCataclysmCast = GameState.RawGameTime
				console.log("[InvokerCombo] Cataclysm casted (target self / double-tap)!")
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 150)
				return true
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
		} else if (this.isIceWallName(name)) {
			if (this.isIceWallUpgraded(hero)) {
				// Ice Floe (Quas Aghanim): vector targeted
				const { origin, end } = this.getIceWallCastPoints(hero, target)
				hero.CastVectorTargetPosition(ability, origin, end)
				console.log("[InvokerCombo] Ice Floe casted!")
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 150)
				return true
			}
			// Vanilla Ice Wall: no target, spawns perpendicular wall in front of hero
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
		} else if (name === "invoker_alacrity") {
			if (this.executeComboAbility(hero, ability, hero)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else if (name === "invoker_cold_snap") {
			if (this.executeComboAbility(hero, ability, target)) {
				console.log("[InvokerCombo] Casted Cold Snap!")
				this.useTargetItem(hero, "item_urn_of_shadows", target, templateId)
				this.useTargetItem(hero, "item_spirit_vessel", target, templateId)
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				return true
			}
		} else if (this.executeComboAbility(hero, ability, target)) {
			this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
			return true
		}

		return false
	}

	private checkAutoCataclysm(hero: Hero): boolean {
		if (
			!this.enableAutoCataclysm.value ||
			this.comboKey.isPressed ||
			hero.IsChanneling ||
			hero.IsStunned ||
			hero.IsSilenced ||
			hero.IsHexed ||
			this.sleeper.Sleeping ||
			GameState.RawGameTime - this.lastCataclysmCast < 2.0
		) {
			return false
		}

		if (!this.cataclysmInvis.value && hero.IsInvisible) {
			return false
		}

		if (!this.hasScepter(hero) || !this.isSunStrikeUpgraded(hero)) {
			return false
		}

		const sunstrike = hero.GetAbilityByName("invoker_sun_strike")
		const ssInvoke = hero.GetAbilityByName("invoker_invoke")
		if (!sunstrike || !sunstrike.IsValid || sunstrike.Level <= 0 || !ssInvoke || !ssInvoke.IsValid) {
			return false
		}

		if (sunstrike.Cooldown > 0.1) {
			return false
		}

		const ssActive = !sunstrike.IsHidden && hero.Mana >= sunstrike.ManaCost
		const canInvoke = ssInvoke.Cooldown <= 0.1 && hero.Mana >= ssInvoke.ManaCost
		const ssInvokable =
			this.cataclysmAutoInvoke.value &&
			sunstrike.IsHidden &&
			canInvoke &&
			hero.Mana >= sunstrike.ManaCost + ssInvoke.ManaCost

		if (!ssActive && !ssInvokable) {
			return false
		}

		let stunnedCount = 0
		let bigUltsCount = 0

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (
				!enemy.IsEnemy(hero) ||
				!enemy.IsAlive ||
				!enemy.IsVisible ||
				!isRealHero(enemy) ||
				enemy.IsInvulnerable
			) {
				continue
			}

			// 1. Check major teamfight CC modifiers
			const hasBigUlt = enemy.Buffs.some(b => BIG_CC_MODIFIERS.includes(b.Name))
			if (hasBigUlt) {
				bigUltsCount++
			}

			// 2. Check general stuns / roots / teleports / channels / bashes / atos / gleipnir
			const isStunned = enemy.IsStunned
			const isRooted = enemy.IsRooted
			const isTeleporting = enemy.Buffs.some(b => b.Name === "modifier_teleporting")
			const isChanneling = enemy.IsChanneling
			const isBashed = enemy.Buffs.some(b => b.Name.startsWith("modifier_bashed"))
			const isAtosOrGleipnir = enemy.Buffs.some(
				b => b.Name === "modifier_rod_of_atos_debuff" || b.Name === "modifier_item_gungir_debuff"
			)

			if (isStunned || isRooted || isTeleporting || isChanneling || isBashed || isAtosOrGleipnir || hasBigUlt) {
				const disableBuff = enemy.Buffs.find(
					b =>
						BIG_CC_MODIFIERS.includes(b.Name) ||
						b.Name === "modifier_teleporting" ||
						b.Name === "modifier_rod_of_atos_debuff" ||
						b.Name === "modifier_item_gungir_debuff" ||
						b.Name === "modifier_stunned" ||
						b.Name.startsWith("modifier_bashed")
				)
				const remTime = disableBuff ? disableBuff.RemainingTime : 1.5
				if (remTime >= 0.8 || hasBigUlt || isChanneling || isTeleporting) {
					stunnedCount++
				}
			}
		}

		const triggerByStun = stunnedCount >= this.cataclysmMinStunned.value
		const triggerByBigUlt = this.cataclysmOnBigUlts.value && bigUltsCount >= this.cataclysmMinBigUlts.value

		if (!triggerByStun && !triggerByBigUlt) {
			this.pendingAutoCataclysm = false
			return false
		}

		if (ssActive) {
			ExecuteOrder.PrepareOrder({
				orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
				issuers: [hero],
				target: hero,
				position: hero.Position.Clone(),
				ability: sunstrike,
				queue: false,
				showEffects: true,
				isPlayerInput: false
			})
			claimOrder()
			this.lastCataclysmCast = GameState.RawGameTime
			this.pendingAutoCataclysm = false
			const reason = triggerByBigUlt
				? `Major Teamfight CC (${bigUltsCount} enemy in Big Ult)`
				: `${stunnedCount} Stunned/Disabled enemies`
			console.log(`[InvokerCombo] Auto Cataclysm Casted! Reason: ${reason}`)
			this.sleeper.Sleep(GameState.InputLag * 1000 + sunstrike.CastPoint * 1000 + 200)
			return true
		} else if (ssInvokable) {
			if (this.invokeSpell(hero, "invoker_sun_strike", ssInvoke)) {
				this.pendingAutoCataclysm = true
				console.log("[InvokerCombo] Auto Cataclysm: Invoking Sunstrike for Cataclysm trigger!")
				this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
				return true
			}
		}

		return false
	}

	private triggerAutoPrepare(hero: Hero, templateId: number): void {
		const tmpl = COMBO_TEMPLATES.find(t => t.id === templateId)
		if (!tmpl) {
			return
		}

		let spells = tmpl.startingSpells
		if (templateId === 0 && this.comboSequenceGrid) {
			const enabled = this.comboSequenceGrid.values.filter((s: string) => this.comboSequenceGrid.IsEnabled(s))
			if (enabled.length >= 2) {
				spells = [enabled[0], enabled[1]]
			}
		}

		const [spell1, spell2] = spells
		const hasSpell1 = hero.Spells.some(s => s && s.Name === spell1 && !s.IsHidden)
		const hasSpell2 = hero.Spells.some(s => s && s.Name === spell2 && !s.IsHidden)

		this.pendingPrepareSpells = []
		if (hasSpell1 && hasSpell2) {
			return
		}

		if (!hasSpell1 && !hasSpell2) {
			// Invoke spell2 first, then spell1, so slot 4 ends up being spell1 and slot 5 is spell2
			this.pendingPrepareSpells = [spell2, spell1]
		} else if (!hasSpell1) {
			this.pendingPrepareSpells = [spell1]
		} else if (!hasSpell2) {
			this.pendingPrepareSpells = [spell2]
		}

		this.processPendingPrepare(hero)
	}

	private processPendingPrepare(hero: Hero): void {
		if (this.pendingPrepareSpells.length === 0) {
			return
		}
		if (hero.IsChanneling || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		const invokeAbility = hero.GetAbilityByName("invoker_invoke")
		if (
			!invokeAbility ||
			!invokeAbility.IsValid ||
			invokeAbility.Cooldown > 0.1 ||
			hero.Mana < invokeAbility.ManaCost
		) {
			return
		}

		const nextSpell = this.pendingPrepareSpells[0]
		if (this.invokeSpell(hero, nextSpell, invokeAbility)) {
			console.log(`[InvokerCombo] Auto Prepare: Invoked ${nextSpell}`)
			this.pendingPrepareSpells.shift()
			this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
		}
	}

	private OnDraw(): void {
		if (!this.hasLocalHero || !this.floatingHudEnabled.value) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (this.isDraggingHud) {
			const cursorPos = InputManager.CursorOnScreen
			const newX = cursorPos.x - this.dragOffsetX
			const newY = cursorPos.y - this.dragOffsetY
			this.floatingHudX.value = Math.max(0, Math.round(newX))
			this.floatingHudY.value = Math.max(0, Math.round(newY))
		}

		const panelX = this.floatingHudX.value
		const panelY = this.floatingHudY.value
		const panelWidth = 330
		const headerHeight = 24
		const rowHeight = 44
		const footerHeight = 26
		const panelHeight = headerHeight + COMBO_TEMPLATES.length * rowHeight + footerHeight

		const panelPos = new Vector2(panelX, panelY)
		const panelSize = new Vector2(panelWidth, panelHeight)

		RendererSDK.FilledRect(panelPos, panelSize, Color.Black.SetA(185))
		RendererSDK.OutlinedRect(panelPos, panelSize, 1, Color.White.SetA(70))

		const headerSize = new Vector2(panelWidth, headerHeight)
		RendererSDK.FilledRect(panelPos, headerSize, Color.Black.SetA(225))
		RendererSDK.OutlinedRect(panelPos, headerSize, 1, Color.White.SetA(70))

		const font = RendererSDK.DefaultFontName
		const titleText = "INVOKER COMBO TEMPLATES"
		const titleSize = RendererSDK.GetTextSize(titleText, font, 11, 700, false)
		const titleX = panelX + (panelWidth - titleSize.x) / 2
		const titleY = panelY + (headerHeight - titleSize.y) / 2
		RendererSDK.Text(titleText, new Vector2(titleX, titleY), Color.White, font, 11, 700, false, true)

		const currentSelectedId = this.activeTemplateDropdown.SelectedID
		for (let i = 0; i < COMBO_TEMPLATES.length; i++) {
			const tmpl = COMBO_TEMPLATES[i]
			const rowY = panelY + headerHeight + i * rowHeight
			const rowPos = new Vector2(panelX + 4, rowY + 2)
			const rowSize = new Vector2(panelWidth - 8, rowHeight - 4)
			const isActive = currentSelectedId === tmpl.id

			if (isActive) {
				RendererSDK.FilledRect(rowPos, rowSize, Color.Green.SetA(45))
				RendererSDK.OutlinedRect(rowPos, rowSize, 2, Color.Green)
			} else {
				RendererSDK.FilledRect(rowPos, rowSize, Color.Black.SetA(140))
				RendererSDK.OutlinedRect(rowPos, rowSize, 1, Color.White.SetA(40))
			}

			const tagColor = isActive ? Color.Green : Color.White
			RendererSDK.Text(tmpl.tag, new Vector2(rowPos.x + 8, rowPos.y + 4), tagColor, font, 11, 700, false, true)
			RendererSDK.Text(tmpl.desc, new Vector2(rowPos.x + 8, rowPos.y + 22), Color.Gray, font, 9, 400, false, true)

			let actions = tmpl.sequenceActions
			if (tmpl.id === 0 && this.comboSequenceGrid) {
				const enabled = this.comboSequenceGrid.values.filter((s: string) => this.comboSequenceGrid.IsEnabled(s))
				if (enabled.length > 0) {
					actions = enabled.slice(0, 5)
				}
			}

			const iconW = 24
			const iconH = 24
			const iconGap = 4
			const totalIconsW = actions.length * iconW + (actions.length - 1) * iconGap
			const startIconX = rowPos.x + rowSize.x - totalIconsW - 6
			const iconY = rowPos.y + (rowSize.y - iconH) / 2

			for (let j = 0; j < actions.length; j++) {
				const action = actions[j]
				const isItem = action.startsWith("item_")
				const path = isItem ? ImageData.GetItemTexture(action) : ImageData.GetSpellTexture(action)
				const iconPos = new Vector2(startIconX + j * (iconW + iconGap), iconY)
				const iconSize = new Vector2(iconW, iconH)

				RendererSDK.Image(path, iconPos, -1, iconSize, Color.White, 0, undefined, false)

				const iconBorderColor = isItem
					? Color.Yellow.SetA(160)
					: isActive
					? Color.Green.SetA(180)
					: Color.White.SetA(70)
				RendererSDK.OutlinedRect(iconPos, iconSize, 1, iconBorderColor)
			}
		}

		const footerY = panelY + headerHeight + COMBO_TEMPLATES.length * rowHeight
		const footerPos = new Vector2(panelX + 4, footerY + 2)
		const footerSize = new Vector2(panelWidth - 8, footerHeight - 4)
		const prepEnabled = this.autoPrepareSpells.value

		RendererSDK.FilledRect(footerPos, footerSize, Color.Black.SetA(200))
		RendererSDK.OutlinedRect(footerPos, footerSize, 1, prepEnabled ? Color.Green.SetA(140) : Color.Red.SetA(140))

		const prepText = `Auto Prepare Starting Spells: [ ${prepEnabled ? "ON" : "OFF"} ]`
		const prepTextSize = RendererSDK.GetTextSize(prepText, font, 9, 700, false)
		const prepTextX = footerPos.x + (footerSize.x - prepTextSize.x) / 2
		const prepTextY = footerPos.y + (footerSize.y - prepTextSize.y) / 2

		RendererSDK.Text(
			prepText,
			new Vector2(prepTextX, prepTextY),
			prepEnabled ? Color.Green : Color.Red,
			font,
			9,
			700,
			false,
			true
		)
	}

	private OnMouseKeyDown(key: VMouseKeys): boolean | void {
		if (key !== VMouseKeys.MK_LBUTTON) {
			return
		}
		if (!this.hasLocalHero || !this.floatingHudEnabled.value) {
			return
		}
		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid) {
			return
		}

		const cursorPos = InputManager.CursorOnScreen
		const panelX = this.floatingHudX.value
		const panelY = this.floatingHudY.value
		const panelWidth = 330
		const headerHeight = 24
		const rowHeight = 44
		const footerHeight = 26
		const panelHeight = headerHeight + COMBO_TEMPLATES.length * rowHeight + footerHeight

		const panelRect = new Rectangle(
			new Vector2(panelX, panelY),
			new Vector2(panelX + panelWidth, panelY + panelHeight)
		)

		if (!panelRect.Contains(cursorPos)) {
			return
		}

		const headerRect = new Rectangle(
			new Vector2(panelX, panelY),
			new Vector2(panelX + panelWidth, panelY + headerHeight)
		)
		if (headerRect.Contains(cursorPos)) {
			this.isDraggingHud = true
			this.dragOffsetX = cursorPos.x - panelX
			this.dragOffsetY = cursorPos.y - panelY
			return true
		}

		for (let i = 0; i < COMBO_TEMPLATES.length; i++) {
			const rowY = panelY + headerHeight + i * rowHeight
			const rowRect = new Rectangle(
				new Vector2(panelX + 4, rowY + 2),
				new Vector2(panelX + panelWidth - 4, rowY + rowHeight - 2)
			)
			if (rowRect.Contains(cursorPos)) {
				const tmpl = COMBO_TEMPLATES[i]
				this.activeTemplateDropdown.SelectedID = tmpl.id
				if (this.autoPrepareSpells.value) {
					this.triggerAutoPrepare(hero, tmpl.id)
				}
				Menu.Base.SaveConfigASAP = true
				return true
			}
		}

		const footerY = panelY + headerHeight + COMBO_TEMPLATES.length * rowHeight
		const footerRect = new Rectangle(
			new Vector2(panelX + 4, footerY + 2),
			new Vector2(panelX + panelWidth - 4, footerY + footerHeight - 2)
		)
		if (footerRect.Contains(cursorPos)) {
			this.autoPrepareSpells.value = !this.autoPrepareSpells.value
			if (this.autoPrepareSpells.value) {
				this.triggerAutoPrepare(hero, this.activeTemplateDropdown.SelectedID)
			}
			Menu.Base.SaveConfigASAP = true
			return true
		}
	}

	private OnMouseKeyUp(key: VMouseKeys): boolean | void {
		if (key === VMouseKeys.MK_LBUTTON && this.isDraggingHud) {
			this.isDraggingHud = false
			Menu.Base.SaveConfigASAP = true
			return true
		}
	}

	private onGameEnded(): void {
		this.sleeper.ResetTimer()
		this.lockedTarget = undefined
		this.pendingAutoSkill = null
		this.autoSkillCursorPos = null
		this.isDraggingHud = false
		this.pendingPrepareSpells = []
		this.pSDK.DestroyAll()
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		if (this.sleeper.lastSleepTickCount > (GameState.RawGameTime + 60) * 1000) {
			this.sleeper.ResetTimer()
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (!this.comboEnabled.value) {
			return
		}

		if (this.pendingPrepareSpells.length > 0 && !this.comboKey.isPressed && !this.sleeper.Sleeping) {
			this.processPendingPrepare(hero)
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

				let ability = hero.GetAbilityByName(spellName)
				if (spellName === "invoker_ice_wall") {
					ability = this.getActiveIceWallAbility(hero)
				}
				if (!ability || !ability.IsValid || ability.Level <= 0) {
					continue
				}

				const autoSkillInvoke = hero.GetAbilityByName("invoker_invoke")
				const isActive = !ability.IsHidden
				const modeAutoUse = config.mode.SelectedID === 0 // 0 = Auto Use, 1 = Only Craft

				if (!isActive) {
					// Need to invoke first
					if (
						!autoSkillInvoke ||
						!autoSkillInvoke.IsValid ||
						autoSkillInvoke.Cooldown > 0.1 ||
						hero.Mana < autoSkillInvoke.ManaCost
					) {
						continue
					}
					if (this.invokeSpell(hero, spellName, autoSkillInvoke)) {
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
					claimOrder()
					console.log(`[InvokerCombo] Auto Skill: Cast ${spellName} (no target)`)
					if (spellName === "invoker_ghost_walk") {
						this.switchOrbs(hero, "wex")
					}
					this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
					this.pendingAutoSkill = null
					this.autoSkillCursorPos = null
					return
				}

				if (ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
					const isSelfCast = spellName === "invoker_alacrity"
					const castTarget = isSelfCast
						? hero
						: (() => {
								const enemies = EntityManager.GetEntitiesByClass(Hero)
								let best: Hero | undefined
								let minDist = Infinity
								for (const enemy of enemies) {
									if (enemy.IsEnemy(hero) && enemy.IsAlive && enemy.IsVisible && isRealHero(enemy)) {
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
						claimOrder()
						console.log(`[InvokerCombo] Auto Skill: Cast ${spellName} on target`)
						this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
						this.pendingAutoSkill = null
						this.autoSkillCursorPos = null
						return
					}
					continue
				}

				// Point-targeted spell
				if (spellName === "invoker_ice_wall" && this.isIceWallUpgraded(hero)) {
					const end = cursorPos.Extend(hero.Position, 600)
					hero.CastVectorTargetPosition(ability, cursorPos, end)
					claimOrder()
					console.log(`[InvokerCombo] Auto Skill: Cast ${spellName} as vector at cursor`)
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
					claimOrder()
					console.log(`[InvokerCombo] Auto Skill: Cast ${spellName} at cursor`)
				}
				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
				this.pendingAutoSkill = null
				this.autoSkillCursorPos = null
				return
			}
		} // end channeling/stunned check

		// --- Pending Auto Skill Cast ---
		if (this.pendingAutoSkill && !hero.IsChanneling && !hero.IsStunned && !hero.IsSilenced && !hero.IsHexed) {
			let ability = hero.GetAbilityByName(this.pendingAutoSkill)
			if (this.pendingAutoSkill === "invoker_ice_wall") {
				ability = this.getActiveIceWallAbility(hero)
			}
			if (
				ability &&
				ability.IsValid &&
				!ability.IsHidden &&
				ability.Cooldown <= 0.1 &&
				hero.Mana >= ability.ManaCost
			) {
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
					claimOrder()
					console.log(`[InvokerCombo] Auto Skill: Cast pending ${this.pendingAutoSkill} (no target)`)
					if (this.pendingAutoSkill === "invoker_ghost_walk") {
						this.switchOrbs(hero, "wex")
					}
				} else if (ability.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)) {
					const isSelfCast = this.pendingAutoSkill === "invoker_alacrity"
					const castTarget = isSelfCast
						? hero
						: (() => {
								const enemies = EntityManager.GetEntitiesByClass(Hero)
								let best: Hero | undefined
								let minDist = Infinity
								for (const enemy of enemies) {
									if (enemy.IsEnemy(hero) && enemy.IsAlive && enemy.IsVisible && isRealHero(enemy)) {
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
						claimOrder()
						console.log(`[InvokerCombo] Auto Skill: Cast pending ${this.pendingAutoSkill} on target`)
					}
				} else if (this.pendingAutoSkill === "invoker_ice_wall" && this.isIceWallUpgraded(hero)) {
					const end = cursorPos.Extend(hero.Position, 600)
					hero.CastVectorTargetPosition(ability, cursorPos, end)
					claimOrder()
					console.log(`[InvokerCombo] Auto Skill: Cast pending ${this.pendingAutoSkill} as vector at cursor`)
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
					claimOrder()
					console.log(`[InvokerCombo] Auto Skill: Cast pending ${this.pendingAutoSkill} at cursor`)
				}

				this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
			}
			this.pendingAutoSkill = null
			this.autoSkillCursorPos = null
			return
		}

		// --- Auto Disrupt Channeling ---
		// @ts-ignore
		if (
			this.enableDisrupt &&
			!this.comboKey.isPressed &&
			!hero.IsChanneling &&
			!hero.IsStunned &&
			!hero.IsSilenced &&
			!hero.IsHexed &&
			!this.sleeper.Sleeping
		) {
			if (this.disruptInvis.value || !hero.IsInvisible) {
				let disruptTarget: Hero | undefined
				let minDist = Infinity
				for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
					if (enemy.IsEnemy(hero) && enemy.IsAlive && isRealHero(enemy) && !enemy.IsMagicImmune) {
						const isChanneling =
							enemy.IsChanneling ||
							enemy.Buffs.some(b => {
								// Don't disrupt if an ally is the one channeling
								if (
									b.Name === "modifier_pudge_dismember" ||
									b.Name.startsWith("modifier_bane_fiends_grip") ||
									b.Name.startsWith("modifier_shadow_shaman_shackles")
								) {
									if (b.Caster && !b.Caster.IsEnemy(hero)) {
										return false
									}
									return true
								}
								return (
									b.Name === "modifier_teleporting" ||
									b.Name.startsWith("modifier_enigma_black_hole") ||
									b.Name.startsWith("modifier_crystal_maiden_freezing_field") ||
									b.Name.startsWith("modifier_witch_doctor_voodoo_swtich") ||
									b.Name.startsWith("modifier_sandking_epicenter_channel") ||
									b.Name.startsWith("modifier_monkey_king_primal_spring") ||
									b.Name.startsWith("modifier_elder_titan_echo_stomp_channel") ||
									b.Name.startsWith("modifier_tinker_rearm")
								)
							})
						const isDuelingAlly = enemy.Buffs.some(b => {
							if (!b.Name.startsWith("modifier_legion_commander_duel")) {
								return false
							}
							if (!b.Caster) {
								return true
							} // can't verify, assume yes
							return b.Caster.IsEnemy(hero)
						})

						if (!isChanneling && !isDuelingAlly) {
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
					const disruptInvoke = hero.GetAbilityByName("invoker_invoke")
					const canInvoke =
						disruptInvoke &&
						disruptInvoke.IsValid &&
						disruptInvoke.Cooldown <= 0.1 &&
						hero.Mana >= disruptInvoke.ManaCost
					const coldSnapRange = 1000

					let chosenSpell = ""

					// Check Cold Snap availability (active or can be invoked)
					if (useColdSnap && minDist <= coldSnapRange) {
						const coldSnap = hero.GetAbilityByName("invoker_cold_snap")
						if (coldSnap && coldSnap.IsValid && coldSnap.Level > 0) {
							const csActive =
								!coldSnap.IsHidden && coldSnap.Cooldown <= 0.1 && hero.Mana >= coldSnap.ManaCost
							const csInvokable =
								coldSnap.IsHidden &&
								canInvoke &&
								coldSnap.Cooldown <= 0.1 &&
								hero.Mana >= coldSnap.ManaCost + disruptInvoke.ManaCost
							if (csActive || csInvokable) {
								chosenSpell = "invoker_cold_snap"
							}
						}
					}

					// Fallback to Tornado
					if (chosenSpell === "" && useTornado) {
						const tornado = hero.GetAbilityByName("invoker_tornado")
						if (tornado && tornado.IsValid && tornado.Level > 0) {
							const tActive =
								!tornado.IsHidden && tornado.Cooldown <= 0.1 && hero.Mana >= tornado.ManaCost
							const tInvokable =
								tornado.IsHidden &&
								canInvoke &&
								tornado.Cooldown <= 0.1 &&
								hero.Mana >= tornado.ManaCost + disruptInvoke.ManaCost
							const tornadoRange = tornado.CastRange > 0 ? tornado.CastRange : 2000
							if ((tActive || tInvokable) && minDist <= tornadoRange) {
								chosenSpell = "invoker_tornado"
							}
						}
					}

					if (chosenSpell !== "") {
						const ability = hero.GetAbilityByName(chosenSpell)
						if (ability && ability.IsValid && ability.Level > 0) {
							const isActive = !ability.IsHidden
							if (!isActive) {
								if (
									disruptInvoke &&
									disruptInvoke.IsValid &&
									disruptInvoke.Cooldown <= 0.1 &&
									hero.Mana >= disruptInvoke.ManaCost
								) {
									if (this.invokeSpell(hero, chosenSpell, disruptInvoke)) {
										console.log(
											`[InvokerCombo] Auto Disrupt: Invoking ${chosenSpell} on ${disruptTarget.Name}`
										)
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
								claimOrder()
								console.log(`[InvokerCombo] Auto Disrupt: Cast ${chosenSpell} on ${disruptTarget.Name}`)
								this.sleeper.Sleep(GameState.InputLag * 1000 + ability.CastPoint * 1000 + 100)
								return
							}
						}
					}
				}
			}
		}

		// --- Pending Sunstrike Cast ---
		if (this.pendingSunstrikePos && !hero.IsChanneling && !hero.IsStunned && !hero.IsSilenced && !hero.IsHexed) {
			const ss = hero.GetAbilityByName("invoker_sun_strike")
			if (ss && ss.IsValid && !ss.IsHidden && ss.Cooldown <= 0.1 && hero.Mana >= ss.ManaCost) {
				if (ss.AltCastState) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT,
						issuers: [hero],
						ability: ss.Index,
						queue: false,
						showEffects: false,
						isPlayerInput: false
					})
					claimOrder()
				}
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
					issuers: [hero],
					position: this.pendingSunstrikePos,
					ability: ss.Index,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				claimOrder()
				console.log(
					`[InvokerCombo] Auto Sunstrike: Cast pending at ${this.pendingSunstrikePos.x.toFixed(
						0
					)},${this.pendingSunstrikePos.y.toFixed(0)}`
				)
				this.sleeper.Sleep(GameState.InputLag * 1000 + ss.CastPoint * 1000 + 200)
			}
			this.pendingSunstrikePos = null
			return
		}

		// --- Pending Auto Cataclysm Cast ---
		if (this.pendingAutoCataclysm && !hero.IsChanneling && !hero.IsStunned && !hero.IsSilenced && !hero.IsHexed) {
			const ss = hero.GetAbilityByName("invoker_sun_strike")
			if (ss && ss.IsValid && !ss.IsHidden && ss.Cooldown <= 0.1 && hero.Mana >= ss.ManaCost) {
				ExecuteOrder.PrepareOrder({
					orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
					issuers: [hero],
					target: hero,
					position: hero.Position.Clone(),
					ability: ss,
					queue: false,
					showEffects: true,
					isPlayerInput: false
				})
				claimOrder()
				this.lastCataclysmCast = GameState.RawGameTime
				console.log("[InvokerCombo] Auto Cataclysm: Executed pending Cataclysm!")
				this.sleeper.Sleep(GameState.InputLag * 1000 + ss.CastPoint * 1000 + 200)
			}
			this.pendingAutoCataclysm = false
			return
		}

		// --- Auto Cataclysm ---
		if (this.checkAutoCataclysm(hero)) {
			return
		}

		// --- Auto Sunstrike ---
		// @ts-ignore
		if (
			this.enableSunstrike &&
			!this.comboKey.isPressed &&
			!hero.IsChanneling &&
			!hero.IsStunned &&
			!hero.IsSilenced &&
			!hero.IsHexed &&
			!this.sleeper.Sleeping &&
			GameState.RawGameTime - this.lastCataclysmCast > 2.0
		) {
			if (!this.sunstrikeInvis.value && hero.IsInvisible) {
				// skip invis check below
			} else {
				const ssInvoke = hero.GetAbilityByName("invoker_invoke")
				const sunstrike = hero.GetAbilityByName("invoker_sun_strike")
				if (sunstrike && sunstrike.IsValid && sunstrike.Level > 0 && ssInvoke && ssInvoke.IsValid) {
					const ssActive = !sunstrike.IsHidden && sunstrike.Cooldown <= 0.1 && hero.Mana >= sunstrike.ManaCost
					const canInvoke = ssInvoke.Cooldown <= 0.1 && hero.Mana >= ssInvoke.ManaCost
					const ssInvokable =
						sunstrike.IsHidden &&
						canInvoke &&
						sunstrike.Cooldown <= 0.1 &&
						hero.Mana >= sunstrike.ManaCost + ssInvoke.ManaCost

					if (ssActive || ssInvokable) {
						// --- Sunstrike on Stunned/Channeled ---
						if (this.sunstrikeOnStun.value) {
							for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
								if (
									!enemy.IsEnemy(hero) ||
									!enemy.IsAlive ||
									!enemy.IsVisible ||
									!isRealHero(enemy) ||
									enemy.IsMagicImmune
								) {
									continue
								}
								const isStunned = enemy.IsStunned
								const isTeleporting = enemy.Buffs.some(b => b.Name === "modifier_teleporting")
								const isRooted = enemy.IsRooted
								const isBashed = enemy.Buffs.some(b => b.Name.startsWith("modifier_bashed"))
								const isCycloned = enemy.Buffs.some(
									b =>
										b.Name === "modifier_eul_cyclone" ||
										b.Name === "modifier_wind_waker" ||
										b.Name === "modifier_invoker_tornado"
								)
								const isChanneling =
									enemy.IsChanneling ||
									enemy.Buffs.some(
										b =>
											b.Name === "modifier_teleporting" ||
											b.Name.startsWith("modifier_enigma_black_hole") ||
											b.Name.startsWith("modifier_pudge_dismember") ||
											b.Name.startsWith("modifier_bane_fiends_grip") ||
											b.Name.startsWith("modifier_shadow_shaman_shackles") ||
											b.Name.startsWith("modifier_crystal_maiden_freezing_field") ||
											b.Name.startsWith("modifier_witch_doctor_voodoo_swtich")
									)
								const isDueled = enemy.Buffs.some(b =>
									b.Name.startsWith("modifier_legion_commander_duel")
								)

								if (!isStunned && !isChanneling && !isDueled && !isRooted && !isBashed) {
									// Check cycloned separately (timed)
									if (!isCycloned) {
										continue
									}
								}

								// Skip channeling or stunned enemies that are moving
								// (e.g. Skewer cast point, Pudge Meat Hook drag, Force Staff)
								if ((isChanneling || isStunned) && enemy.IsMoving) {
									continue
								}

								// If only generic IsChanneling (no specific modifier), skip — unreliable cast-point detection
								if (
									isChanneling &&
									!isTeleporting &&
									!enemy.Buffs.some(
										b =>
											b.Name.startsWith("modifier_enigma_black_hole") ||
											b.Name.startsWith("modifier_pudge_dismember") ||
											b.Name.startsWith("modifier_bane_fiends_grip") ||
											b.Name.startsWith("modifier_shadow_shaman_shackles") ||
											b.Name.startsWith("modifier_crystal_maiden_freezing_field") ||
											b.Name.startsWith("modifier_witch_doctor_voodoo_swtich")
									)
								) {
									continue
								}

								// For cycloned enemies, time the sunstrike to hit when they land
								if (isCycloned) {
									const cycloneBuff = enemy.Buffs.find(
										b =>
											b.Name === "modifier_eul_cyclone" ||
											b.Name === "modifier_wind_waker" ||
											b.Name === "modifier_invoker_tornado"
									)
									if (cycloneBuff) {
										const rem = cycloneBuff.RemainingTime
										if (ssActive && (rem > 2.0 || rem < 1.5)) {
											continue
										}
										if (!ssActive && (rem > 2.2 || rem < 1.7)) {
											continue
										}
									}
								}
								// Skip if Cold Snap or Tornado can reach (they handle it in auto disrupt)
								const dist = hero.Distance2D(enemy)
								if (dist <= 2500 && isTeleporting) {
									continue
								}

								const castPos = enemy.Position.Clone()
								if (ssActive) {
									if (sunstrike.AltCastState) {
										ExecuteOrder.PrepareOrder({
											orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT,
											issuers: [hero],
											ability: sunstrike.Index,
											queue: false,
											showEffects: false,
											isPlayerInput: false
										})
										claimOrder()
									}
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
										issuers: [hero],
										position: castPos,
										ability: sunstrike.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
									claimOrder()
									console.log(
										`[InvokerCombo] Auto Sunstrike: Cast on stunned/channeled ${enemy.Name}`
									)
									this.sleeper.Sleep(GameState.InputLag * 1000 + sunstrike.CastPoint * 1000 + 200)
									this.pendingSunstrikePos = null
									return
								} else if (ssInvokable) {
									if (this.invokeSpell(hero, "invoker_sun_strike", ssInvoke)) {
										this.pendingSunstrikePos = castPos
										console.log(`[InvokerCombo] Auto Sunstrike: Invoking for ${enemy.Name}`)
										this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
										return
									}
								}
								break
							}
						}

						// --- Sunstrike Walking Prediction ---
						if (this.sunstrikeOnWalk.value && (ssActive || ssInvokable)) {
							for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
								if (
									!enemy.IsEnemy(hero) ||
									!enemy.IsAlive ||
									!enemy.IsVisible ||
									!isRealHero(enemy) ||
									enemy.IsMagicImmune
								) {
									continue
								}
								const hpPct = (enemy.HP / enemy.MaxHP) * 100
								if (hpPct > this.sunstrikeHPThreshold.value) {
									continue
								}
								const dist = hero.Distance2D(enemy)
								if (dist > 12000) {
									continue
								}
								if (!enemy.IsMoving) {
									continue
								}
								// Predict position: 1.7s sunstrike delay * movement speed
								const moveSpeed = enemy.MoveSpeed > 0 ? enemy.MoveSpeed : 350
								const predTime = 1.7
								const predDistance = moveSpeed * predTime
								const forward = enemy.Forward
								const predictedPos = enemy.Position.Add(forward.MultiplyScalar(predDistance))

								if (ssActive) {
									if (sunstrike.AltCastState) {
										ExecuteOrder.PrepareOrder({
											orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE_ALT,
											issuers: [hero],
											ability: sunstrike.Index,
											queue: false,
											showEffects: false,
											isPlayerInput: false
										})
										claimOrder()
									}
									ExecuteOrder.PrepareOrder({
										orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
										issuers: [hero],
										position: predictedPos,
										ability: sunstrike.Index,
										queue: false,
										showEffects: true,
										isPlayerInput: false
									})
									claimOrder()
									console.log(
										`[InvokerCombo] Auto Sunstrike: Predicted walking ${
											enemy.Name
										} at ${hpPct.toFixed(0)}% HP`
									)
									this.sleeper.Sleep(GameState.InputLag * 1000 + sunstrike.CastPoint * 1000 + 200)
									this.pendingSunstrikePos = null
									return
								} else if (ssInvokable) {
									if (this.invokeSpell(hero, "invoker_sun_strike", ssInvoke)) {
										this.pendingSunstrikePos = predictedPos
										console.log(`[InvokerCombo] Auto Sunstrike: Invoking for walking ${enemy.Name}`)
										this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
										return
									}
								}
								break
							}
						}
					}
				}
			}
		}

		// @ts-ignore
		if (!this.comboKey.isPressed) {
			this.lockedTarget = undefined
			this.pSDK.DestroyByKey("invoker_target_ring")
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
				!isRealHero(this.lockedTarget)
			) {
				this.lockedTarget = undefined
				this.pSDK.DestroyByKey("invoker_target_ring")
			}
		}

		if (!this.lockedTarget) {
			const maxCastRange = 1200
			const mousePos = InputManager.CursorOnWorld
			let foundTarget: Hero | undefined
			let minDist = Infinity

			for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
				if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && isRealHero(enemy)) {
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
			this.pSDK.DestroyByKey("invoker_target_ring")
			return
		}

		this.pSDK.DrawCircle("invoker_target_ring", bestTarget, 140, {
			Color: new Color(100, 200, 255, 220),
			Attachment: ParticleAttachment.PATTACH_ABSORIGIN_FOLLOW
		})

		if (this.sleeper.Sleeping) {
			return
		}

		const selectedTemplate = this.activeTemplateDropdown.SelectedID
		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		if (!isTargetImmune) {
			const blink = this.getBlinkItem(hero, selectedTemplate)
			if (blink && blink.Cooldown <= 0.1 && hero.Mana >= blink.ManaCost) {
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
					claimOrder()
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
			}

			const targetHasSpellBlock = this.hasSpellBlock(bestTarget)
			if (targetHasSpellBlock) {
				// Try to break Linken's with Urn or Spirit Vessel
				const urn = hero.Items.find(
					i =>
						(i.Name === "item_urn_of_shadows" || i.Name === "item_spirit_vessel") &&
						this.isItemEnabledForCombo(i.Name, selectedTemplate) &&
						i.Cooldown <= 0.1 &&
						hero.Mana >= i.ManaCost
				)
				if (urn) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
						issuers: [hero],
						target: bestTarget.Index,
						ability: urn.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					claimOrder()
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
			} else {
				if (this.useTargetItem(hero, "item_sheepstick", bestTarget, selectedTemplate)) {
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}

				if (this.useTargetItem(hero, "item_nullifier", bestTarget, selectedTemplate)) {
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}

				const atos = this.getAtosItem(hero, selectedTemplate)
				if (
					atos &&
					atos.Cooldown <= 0.1 &&
					hero.Mana >= atos.ManaCost &&
					hero.Distance2D(bestTarget) <= 1100 &&
					!bestTarget.IsStunned &&
					!bestTarget.IsRooted
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
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}

				if (
					this.useTargetItem(hero, "item_orchid", bestTarget, selectedTemplate) ||
					this.useTargetItem(hero, "item_bloodthorn", bestTarget, selectedTemplate)
				) {
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
			}

			const tornadoAbility = hero.GetAbilityByName("invoker_tornado")
			const isTornadoReady = tornadoAbility && tornadoAbility.Level > 0 && tornadoAbility.Cooldown <= 0.1
			const hasActiveLiftBuff = bestTarget.Buffs.some(
				m =>
					m.Name === "modifier_invoker_tornado" ||
					m.Name === "modifier_eul_cyclone" ||
					m.Name === "modifier_wind_waker"
			)

			if (selectedTemplate === 1) {
				// In Eul One-Shot template, Eul's / Wind Waker is the prioritized initiation
				if (!hasActiveLiftBuff) {
					if (
						this.useTargetItem(hero, "item_cyclone", bestTarget, selectedTemplate) ||
						this.useTargetItem(hero, "item_wind_waker", bestTarget, selectedTemplate)
					) {
						this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
						return
					}
				}
			} else if (
				selectedTemplate === 0 &&
				!hasActiveLiftBuff &&
				(!isTornadoReady || !this.comboSequenceGrid.IsEnabled("invoker_tornado"))
			) {
				if (
					this.useTargetItem(hero, "item_cyclone", bestTarget, selectedTemplate) ||
					this.useTargetItem(hero, "item_wind_waker", bestTarget, selectedTemplate)
				) {
					this.sleeper.Sleep(GameState.InputLag * 1000 + 100)
					return
				}
			}
		}

		const liftBuff = bestTarget.Buffs.find(
			m =>
				m.Name === "modifier_invoker_tornado" ||
				m.Name === "modifier_eul_cyclone" ||
				m.Name === "modifier_wind_waker"
		)

		const invokeAbility = hero.GetAbilityByName("invoker_invoke")

		let activeSequence: string[] = this.comboSequenceGrid.values

		if (selectedTemplate === 1) {
			// Eul One-Shot: Sun Strike, Chaos Meteor, Deafening Blast, Cold Snap
			activeSequence = [
				"invoker_sun_strike",
				"invoker_chaos_meteor",
				"invoker_deafening_blast",
				"invoker_cold_snap"
			]
		} else if (selectedTemplate === 2) {
			// Cold Snap + Urn: Forge Spirit, Cold Snap, Alacrity, Sun Strike, Ice Wall
			activeSequence = [
				"invoker_forge_spirit",
				"invoker_cold_snap",
				"invoker_alacrity",
				"invoker_sun_strike",
				"invoker_ice_wall"
			]
		} else if (selectedTemplate === 3) {
			// Quas-Wex EMP: Tornado, EMP, Cold Snap
			activeSequence = ["invoker_tornado", "invoker_emp", "invoker_cold_snap"]
		} else if (selectedTemplate === 4) {
			// Late Game: Full combo
			activeSequence = [
				"invoker_tornado",
				"invoker_emp",
				"invoker_chaos_meteor",
				"invoker_sun_strike",
				"invoker_deafening_blast",
				"invoker_ice_wall",
				"invoker_cold_snap"
			]
		}

		for (const spellName of activeSequence) {
			if (selectedTemplate === 0 && !this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			if (spellName === "invoker_forge_spirit") {
				const hasLivingSpirit = EntityManager.GetEntitiesByClass(Unit).some(
					u => u.Name === "npc_dota_invoker_forged_spirit" && u.IsAlive && u.IsControllable
				)
				if (hasLivingSpirit) {
					continue
				}
			}

			let ability = hero.GetAbilityByName(spellName)
			if (spellName === "invoker_ice_wall") {
				ability = this.getActiveIceWallAbility(hero)
			}
			if (!ability || !ability.IsValid || ability.Level <= 0) {
				continue
			}

			if (isTargetImmune && spellName !== "invoker_sun_strike" && spellName !== "invoker_sun_strike_ad") {
				continue
			}

			if (ability.Cooldown > 0.1) {
				continue
			}

			if (
				(spellName === "invoker_sun_strike" || spellName === "invoker_sun_strike_ad") &&
				GameState.RawGameTime - this.lastCataclysmCast < 1.5
			) {
				continue
			}

			if (hero.Mana < ability.ManaCost) {
				continue
			}

			let castRange = ability.CastRange > 0 ? ability.CastRange : 800
			if (spellName === "invoker_sun_strike" || spellName === "invoker_sun_strike_ad") {
				castRange = Infinity
			} else if (spellName === "invoker_ice_wall" && !this.isIceWallUpgraded(hero)) {
				castRange = 520
			}
			if (hero.Distance2D(bestTarget) > castRange) {
				continue
			}

			const active = !ability.IsHidden

			if (!active) {
				if (
					!invokeAbility ||
					!invokeAbility.IsValid ||
					invokeAbility.Cooldown > 0.1 ||
					hero.Mana < invokeAbility.ManaCost
				) {
					let foundLaterSpell = false
					for (let i = activeSequence.indexOf(spellName) + 1; i < activeSequence.length; i++) {
						const laterName = activeSequence[i]
						if (selectedTemplate === 0 && !this.comboSequenceGrid.IsEnabled(laterName)) {
							continue
						}
						const laterAbil = hero.GetAbilityByName(laterName)
						if (
							laterAbil &&
							laterAbil.IsValid &&
							laterAbil.Level > 0 &&
							!laterAbil.IsHidden &&
							laterAbil.Cooldown <= 0.1 &&
							hero.Mana >= laterAbil.ManaCost
						) {
							if (this.castInvokerSpell(hero, laterAbil, bestTarget, liftBuff, selectedTemplate)) {
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

			if (this.castInvokerSpell(hero, ability, bestTarget, liftBuff, selectedTemplate)) {
				return
			}
		}

		if (!isTargetImmune && hero.Distance2D(bestTarget) <= 900) {
			if (this.useNoTargetItem(hero, "item_shivas_guard", selectedTemplate)) {
				this.sleeper.Sleep(GameState.InputLag * 1000 + 50)
				return
			}
		}

		if (this.isItemEnabledForCombo("item_refresher", selectedTemplate)) {
			const refresher = this.getRefresherItem(hero, selectedTemplate)
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
					claimOrder()
					this.sleeper.Sleep(GameState.InputLag * 1000 + 150)
					return
				}
			}
		}

		if (this.autoSwitchOrbs.value) {
			const targetOrb = selectedTemplate === 3 ? "wex" : "exort"
			const orbCount = hero.Buffs.filter(b => b.Name.startsWith(`modifier_invoker_${targetOrb}`)).length
			if (orbCount < 3) {
				const orbAbility = hero.GetAbilityByName(`invoker_${targetOrb}`)
				if (orbAbility && orbAbility.Level > 0) {
					this.switchOrbs(hero, targetOrb)
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
