import {
	Ability,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	LocalPlayer,
	Menu,
	ProjectileManager,
	TickSleeper,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"

const THREAT_ABILITIES = [
	"lion_voodoo",
	"lion_impale",
	"lion_finger_of_death",
	"shadow_shaman_voodoo",
	"shadow_shaman_shackles",
	"vengefulspirit_magic_missile",
	"vengefulspirit_nether_swap",
	"necrolyte_reapers_scythe",
	"bane_fiends_grip",
	"doom_bringer_doom",
	"axe_berserkers_call",
	"batrider_flaming_lasso",
	"pudge_dismember",
	"primal_beast_pulverize",
	"slardar_corrosive_haze",
	"bounty_hunter_track",
	"spirit_breaker_charge_of_darkness",
	"legion_commander_duel",
	"bane_nightmare",
	"invoker_chaos_meteor",
	"invoker_deafening_blast",
	"invoker_sun_strike",
	"lina_laguna_blade",
	"skywrath_mage_mystic_flare",
	"huskar_life_break",
	"pudge_meat_hook",
	"mirana_arrow",
	"windrunner_powershot",
	"sniper_assassinate",
	"beastmaster_primal_roar"
]

const MAGIC_THREAT_ABILITIES = [
	"lion_voodoo",
	"lion_impale",
	"shadow_shaman_voodoo",
	"shadow_shaman_shackles",
	"vengefulspirit_magic_missile",
	"necrolyte_reapers_scythe",
	"doom_bringer_doom",
	"item_orchid",
	"item_bloodthorn",
	"item_sheepstick",
	"item_nullifier",
	"lina_laguna_blade",
	"skywrath_mage_mystic_flare",
	"invoker_chaos_meteor",
	"invoker_sun_strike",
	"invoker_deafening_blast",
	"sniper_assassinate"
]

const TARGETED_REFLECT_SPELLS = [
	"lion_finger_of_death",
	"lina_laguna_blade",
	"necrolyte_reapers_scythe",
	"doom_bringer_doom",
	"bane_fiends_grip",
	"beastmaster_primal_roar",
	"legion_commander_duel",
	"spirit_breaker_charge_of_darkness",
	"vengefulspirit_magic_missile",
	"item_orchid",
	"item_bloodthorn",
	"item_sheepstick",
	"item_nullifier",
	"item_dagon",
	"item_dagon_2",
	"item_dagon_3",
	"item_dagon_4",
	"item_dagon_5"
]

const FATAL_MODIFIERS = [
	"modifier_legion_commander_duel",
	"modifier_necrolyte_reapers_scythe",
	"modifier_bane_fiends_grip",
	"modifier_batrider_flaming_lasso",
	"modifier_shadow_shaman_shackles",
	"modifier_enigma_black_hole_pull",
	"modifier_faceless_void_chronosphere_freeze",
	"modifier_winter_wyvern_winters_curse",
	"modifier_winter_wyvern_winters_curse_aura",
	"modifier_axe_berserkers_call",
	"modifier_magnus_reverse_polarity",
	"modifier_doom_bringer_doom",
	"modifier_pudge_dismember",
	"modifier_primal_beast_pulverize",
	"modifier_ice_blast",
	"modifier_witch_doctor_maledict"
]

const AOE_THREATS = [
	{ name: "enigma_black_hole", radius: 500 },
	{ name: "faceless_void_chronosphere", radius: 550 },
	{ name: "magnataur_reverse_polarity", radius: 430 },
	{ name: "tidehunter_ravage", radius: 1200 },
	{ name: "axe_berserkers_call", radius: 315 },
	{ name: "earthshaker_echo_slam", radius: 600 }
]

new (class AutoDodgerUtility {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode("Auto Dodger (Self-Defense)")
	private readonly enabled = this.node.AddToggle("Enabled", true, "Master toggle for Auto Dodger")

	// Items settings
	private readonly itemsNode = this.node.AddNode("Dodge Items")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Items Selection",
		[
			"item_manta",
			"item_cyclone",
			"item_wind_waker",
			"item_black_king_bar",
			"item_blade_mail",
			"item_lotus_orb",
			"item_blink"
		],
		new Map([
			["item_manta", true],
			["item_cyclone", true],
			["item_wind_waker", true],
			["item_black_king_bar", true],
			["item_blade_mail", true],
			["item_lotus_orb", true],
			["item_blink", true]
		]),
		"Select items to automatically cast for self dodging & evasion",
		true
	)

	// Hero Evasive Spells settings
	private readonly heroSpellsNode = this.node.AddNode("Hero Evasive Spells")
	private readonly heroSpellsSelector = this.heroSpellsNode.AddImageSelector(
		"Spells Selection",
		[
			"puck_phase_shift",
			"nyx_assassin_spiked_carapace",
			"antimage_counterspell",
			"ember_spirit_sleight_of_fist",
			"phantom_lancer_doppelwalk",
			"morphling_waveform",
			"dark_willow_shadow_realm",
			"riki_tricks_of_the_trade",
			"slark_dark_pact",
			"slark_shadow_dance",
			"faceless_void_time_walk",
			"storm_spirit_ball_lightning"
		],
		new Map([
			["puck_phase_shift", true],
			["nyx_assassin_spiked_carapace", true],
			["antimage_counterspell", true],
			["ember_spirit_sleight_of_fist", true],
			["phantom_lancer_doppelwalk", true],
			["morphling_waveform", true],
			["dark_willow_shadow_realm", true],
			["riki_tricks_of_the_trade", true],
			["slark_dark_pact", true],
			["slark_shadow_dance", true],
			["faceless_void_time_walk", true],
			["storm_spirit_ball_lightning", true]
		]),
		"Select hero abilities to automatically use for self dodging",
		true
	)

	// Manta Dispel Options
	private readonly mantaDispelNode = this.itemsNode.AddNode("Manta Dispel Options")
	private readonly mantaDispelSilence = this.mantaDispelNode.AddToggle("Dispel Silence", true)
	private readonly mantaDispelRoot = this.mantaDispelNode.AddToggle("Dispel Root", true)

	private readonly castSleeper = new TickSleeper()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.GameEnded.bind(this))
	}

	private executeAndClaimOrder(castFn: () => void, delay: number): void {
		castFn()
		claimOrder()
		this.castSleeper.Sleep(delay)
	}

	private get hasLocalHero(): boolean {
		return LocalPlayer?.Hero !== undefined && LocalPlayer.Hero.IsValid === true
	}

	private hasFatalDebuff(unit: Hero): boolean {
		return FATAL_MODIFIERS.some(mod => unit.HasBuffByName(mod))
	}

	private getThreatProjectileTimeToImpact(target: Hero): number {
		let minTime = Infinity

		// 1. Tracking Projectiles targeting local hero
		for (const proj of ProjectileManager.AllTrackingProjectiles) {
			if (proj.Target === target && proj.Ability) {
				const name = proj.Ability.Name
				if (MAGIC_THREAT_ABILITIES.includes(name) || THREAT_ABILITIES.includes(name)) {
					const dist = proj.Position.Distance2D(target.Position)
					const timeToImpact = dist / Math.max(1, proj.Speed)
					if (timeToImpact < minTime) {
						minTime = timeToImpact
					}
				}
			}
		}

		// 2. Linear / Skillshot Projectiles directed at local hero
		for (const proj of ProjectileManager.AllLinearProjectiles) {
			if (
				proj.Ability &&
				(MAGIC_THREAT_ABILITIES.includes(proj.Ability.Name) || THREAT_ABILITIES.includes(proj.Ability.Name))
			) {
				const p = target.Position
				const a = proj.Position
				const b = proj.TargetLoc

				if (!b) {
					continue
				}

				const ab = new Vector3(b.x - a.x, b.y - a.y, b.z - a.z)
				const ap = new Vector3(p.x - a.x, p.y - a.y, p.z - a.z)

				const abLenSqr = ab.LengthSqr
				let t = 0
				if (abLenSqr > 0) {
					t = Math.max(0, Math.min(1, ap.Dot(ab) / abLenSqr))
				}

				const projection = a.Add(ab.MultiplyScalar(t))
				const distanceToPath = p.Distance2D(projection)

				const collisionSize = 130
				if (distanceToPath < collisionSize + 24) {
					const projToHeroDist = a.Distance2D(projection)
					if (t > 0 && t <= 1) {
						const timeToImpact = projToHeroDist / Math.max(1, proj.Speed || 1000)
						if (timeToImpact < minTime) {
							minTime = timeToImpact
						}
					}
				}
			}
		}

		return minTime
	}

	private getDangerAoEAnimations(target: Hero, allHeroes: Hero[]): { enemy: Hero; ability: Ability } | null {
		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
				for (const abil of spells) {
					if (abil.IsInAbilityPhase) {
						const aoe = AOE_THREATS.find(a => a.name === abil.Name)
						if (aoe) {
							if (enemy.Distance2D(target, true) <= aoe.radius + 50) {
								return { enemy, ability: abil }
							}
						}
					}
				}
			}
		}
		return null
	}

	private getIncomingTargetedSpell(target: Hero, allHeroes: Hero[]): { enemy: Hero; ability: Ability } | null {
		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
				for (const abil of spells) {
					if (abil.IsInAbilityPhase && TARGETED_REFLECT_SPELLS.includes(abil.Name)) {
						if (enemy.Distance2D(target, true) <= (abil.CastRange || 800) + 150) {
							return { enemy, ability: abil }
						}
					}
				}
			}
		}
		return null
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (hero === undefined || !hero.IsValid || !hero.IsAlive) {
			return
		}

		if (!this.enabled.value || this.castSleeper.Sleeping) {
			return
		}

		if (hero.IsChanneling || hero.IsInvisible) {
			return
		}

		const allHeroes = EntityManager.GetEntitiesByClass(Hero)
		const delay = GameState.InputLag * 1000 + Math.randomRange(40, 100)

		const timeToImpact = this.getThreatProjectileTimeToImpact(hero)
		const aoeThreat = this.getDangerAoEAnimations(hero, allHeroes)
		const targetedThreat = this.getIncomingTargetedSpell(hero, allHeroes)
		const inFatal = this.hasFatalDebuff(hero)

		const isDodgeNeeded = timeToImpact <= GameState.InputLag + 0.12 || aoeThreat !== null
		const isEarlyDodgeNeeded =
			timeToImpact <= GameState.InputLag + 0.35 || aoeThreat !== null || targetedThreat !== null

		const isSilencedOrRooted =
			(this.mantaDispelSilence.value && hero.IsSilenced) || (this.mantaDispelRoot.value && hero.IsRooted)

		// -------------------------------------------------------------
		// 1. HERO EVASIVE SPELLS (Phase Shift, Counterspell, Carapace, Sleight, Doppel, etc.)
		// -------------------------------------------------------------

		// 1a. Puck Phase Shift
		if (
			this.heroSpellsSelector.IsEnabled("puck_phase_shift") &&
			hero.Name === "npc_dota_hero_puck" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const phase = hero.GetAbilityByName("puck_phase_shift")
			if (phase && phase.IsValid && phase.Level > 0 && phase.Cooldown <= 0.1 && hero.IsManaEnough(phase)) {
				if (!hero.HasBuffByName("modifier_puck_phase_shift")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(phase), delay)
						return
					}
				}
			}
		}

		// 1b. Nyx Spiked Carapace
		if (
			this.heroSpellsSelector.IsEnabled("nyx_assassin_spiked_carapace") &&
			hero.Name === "npc_dota_hero_nyx_assassin" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const carapace = hero.GetAbilityByName("nyx_assassin_spiked_carapace")
			if (
				carapace &&
				carapace.IsValid &&
				carapace.Level > 0 &&
				carapace.Cooldown <= 0.1 &&
				hero.IsManaEnough(carapace)
			) {
				if (!hero.HasBuffByName("modifier_nyx_assassin_spiked_carapace")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(carapace), delay)
						return
					}
				}
			}
		}

		// 1c. Anti-Mage Counterspell
		if (
			this.heroSpellsSelector.IsEnabled("antimage_counterspell") &&
			hero.Name === "npc_dota_hero_antimage" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const cs = hero.GetAbilityByName("antimage_counterspell")
			if (cs && cs.IsValid && cs.Level > 0 && cs.Cooldown <= 0.1 && hero.IsManaEnough(cs)) {
				if (!hero.HasBuffByName("modifier_antimage_counterspell")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(cs), delay)
						return
					}
				}
			}
		}

		// 1d. Ember Spirit Sleight of Fist
		if (
			this.heroSpellsSelector.IsEnabled("ember_spirit_sleight_of_fist") &&
			hero.Name === "npc_dota_hero_ember_spirit" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const sof = hero.GetAbilityByName("ember_spirit_sleight_of_fist")
			if (sof && sof.IsValid && sof.Level > 0 && sof.Cooldown <= 0.1 && hero.IsManaEnough(sof)) {
				if (isEarlyDodgeNeeded || inFatal) {
					const nearbyEnemy = allHeroes.find(
						e =>
							e &&
							e.IsValid &&
							e.IsAlive &&
							e.IsEnemy(hero) &&
							hero.Distance2D(e) <= (sof.CastRange || 700)
					)
					if (nearbyEnemy) {
						this.executeAndClaimOrder(() => hero.CastPosition(sof, nearbyEnemy.Position), delay)
						return
					}
				}
			}
		}

		// 1e. Phantom Lancer Doppelganger
		if (
			this.heroSpellsSelector.IsEnabled("phantom_lancer_doppelwalk") &&
			hero.Name === "npc_dota_hero_phantom_lancer" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const doppel = hero.GetAbilityByName("phantom_lancer_doppelwalk")
			if (doppel && doppel.IsValid && doppel.Level > 0 && doppel.Cooldown <= 0.1 && hero.IsManaEnough(doppel)) {
				if (isEarlyDodgeNeeded || inFatal || isSilencedOrRooted) {
					this.executeAndClaimOrder(() => hero.CastPosition(doppel, hero.Position), delay)
					return
				}
			}
		}

		// 1f. Dark Willow Shadow Realm
		if (
			this.heroSpellsSelector.IsEnabled("dark_willow_shadow_realm") &&
			hero.Name === "npc_dota_hero_dark_willow" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const realm = hero.GetAbilityByName("dark_willow_shadow_realm")
			if (realm && realm.IsValid && realm.Level > 0 && realm.Cooldown <= 0.1 && hero.IsManaEnough(realm)) {
				if (!hero.HasBuffByName("modifier_dark_willow_shadow_realm_buff")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(realm), delay)
						return
					}
				}
			}
		}

		// 1g. Morphling Waveform
		if (
			this.heroSpellsSelector.IsEnabled("morphling_waveform") &&
			hero.Name === "npc_dota_hero_morphling" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const wave = hero.GetAbilityByName("morphling_waveform")
			if (wave && wave.IsValid && wave.Level > 0 && wave.Cooldown <= 0.1 && hero.IsManaEnough(wave)) {
				if (isEarlyDodgeNeeded || inFatal) {
					const escapePos = hero.Position.Add(hero.Forward.MultiplyScalar(400))
					this.executeAndClaimOrder(() => hero.CastPosition(wave, escapePos), delay)
					return
				}
			}
		}

		// 1h. Slark Dark Pact / Shadow Dance
		if (
			hero.Name === "npc_dota_hero_slark" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const pact = hero.GetAbilityByName("slark_dark_pact")
			if (
				this.heroSpellsSelector.IsEnabled("slark_dark_pact") &&
				pact &&
				pact.IsValid &&
				pact.Level > 0 &&
				pact.Cooldown <= 0.1 &&
				hero.IsManaEnough(pact)
			) {
				if (isEarlyDodgeNeeded || isSilencedOrRooted || inFatal) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(pact), delay)
					return
				}
			}

			const dance = hero.GetAbilityByName("slark_shadow_dance")
			if (
				this.heroSpellsSelector.IsEnabled("slark_shadow_dance") &&
				dance &&
				dance.IsValid &&
				dance.Level > 0 &&
				dance.Cooldown <= 0.1 &&
				hero.IsManaEnough(dance)
			) {
				if (hero.HP / hero.MaxHP <= 0.35 || inFatal) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(dance), delay)
					return
				}
			}
		}

		// 1i. Faceless Void Time Walk
		if (
			this.heroSpellsSelector.IsEnabled("faceless_void_time_walk") &&
			hero.Name === "npc_dota_hero_faceless_void" &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsSilenced
		) {
			const tw = hero.GetAbilityByName("faceless_void_time_walk")
			if (tw && tw.IsValid && tw.Level > 0 && tw.Cooldown <= 0.1 && hero.IsManaEnough(tw)) {
				if (isEarlyDodgeNeeded || inFatal) {
					const escapePos = hero.Position.AddScalarX(300)
					this.executeAndClaimOrder(() => hero.CastPosition(tw, escapePos), delay)
					return
				}
			}
		}

		// -------------------------------------------------------------
		// 2. ITEMS (Manta, Blink, Eul, Wind Waker, Lotus, BKB, Blade Mail)
		// -------------------------------------------------------------

		// 2a. Manta Style (Self dodge & Dispel)
		if (this.itemsSelector.IsEnabled("item_manta") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const manta = hero.GetItemByName("item_manta")
			if (manta && manta.CanBeUsable && manta.Cooldown <= 0.1 && hero.IsManaEnough(manta)) {
				if (isDodgeNeeded || isSilencedOrRooted) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(manta), delay)
					return
				}
			}
		}

		// 2b. Lotus Orb Self Reflect
		if (this.itemsSelector.IsEnabled("item_lotus_orb") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const lotus = hero.GetItemByName("item_lotus_orb")
			if (lotus && lotus.CanBeUsable && lotus.Cooldown <= 0.1 && hero.IsManaEnough(lotus)) {
				if (!hero.HasBuffByName("modifier_item_lotus_orb_active")) {
					if (targetedThreat !== null || timeToImpact <= 0.5 || isSilencedOrRooted) {
						this.executeAndClaimOrder(() => hero.CastTarget(lotus, hero), delay)
						return
					}
				}
			}
		}

		// 2c. Blink Dagger Disjoint / Escape from AoE
		if (
			this.itemsSelector.IsEnabled("item_blink") &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			!hero.IsRooted
		) {
			const blink = hero.Items.find(
				i =>
					i.Name === "item_blink" ||
					i.Name === "item_arcane_blink" ||
					i.Name === "item_swift_blink" ||
					i.Name === "item_overwhelming_blink"
			)
			if (blink && blink.CanBeUsable && blink.Cooldown <= 0.1) {
				if (aoeThreat !== null) {
					const escapePos = hero.Position.Extend(aoeThreat.enemy.Position, -900)
					this.executeAndClaimOrder(() => hero.CastPosition(blink, escapePos), delay)
					return
				}
				if (timeToImpact <= 0.25) {
					const escapePos = hero.Position.AddScalarX(800)
					this.executeAndClaimOrder(() => hero.CastPosition(blink, escapePos), delay)
					return
				}
			}
		}

		// 2d. Blade Mail
		if (this.itemsSelector.IsEnabled("item_blade_mail") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const bm = hero.GetItemByName("item_blade_mail")
			if (bm && bm.CanBeUsable && bm.Cooldown <= 0.1 && hero.IsManaEnough(bm)) {
				if (!hero.HasBuffByName("modifier_item_blade_mail_reflect")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(bm), delay)
						return
					}
				}
			}
		}

		// 2e. Black King Bar (BKB)
		if (this.itemsSelector.IsEnabled("item_black_king_bar") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const bkb = hero.GetItemByName("item_black_king_bar")
			if (bkb && bkb.CanBeUsable && bkb.Cooldown <= 0.1) {
				if (!hero.IsDebuffImmune && !hero.IsMagicImmune) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(bkb), delay)
						return
					}
				}
			}
		}

		// 2f. Eul's Scepter / Wind Waker Self Cyclone
		if (
			(this.itemsSelector.IsEnabled("item_cyclone") || this.itemsSelector.IsEnabled("item_wind_waker")) &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed
		) {
			const ww = hero.GetItemByName("item_wind_waker")
			const eul = hero.GetItemByName("item_cyclone")
			const cyclone =
				ww && ww.CanBeUsable && ww.Cooldown <= 0.1 && hero.IsManaEnough(ww)
					? ww
					: eul && eul.CanBeUsable && eul.Cooldown <= 0.1 && hero.IsManaEnough(eul)
					? eul
					: undefined

			if (cyclone) {
				if (!hero.HasBuffByName("modifier_eul_cyclone") && !hero.HasBuffByName("modifier_wind_waker")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastTarget(cyclone, hero), delay)
					}
				}
			}
		}
	}

	private GameEnded(): void {
		this.castSleeper.ResetTimer()
	}
})()
