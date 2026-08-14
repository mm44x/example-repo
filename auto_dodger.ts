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
	Vector3,
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
	"windrunner_powershot"
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
	"invoker_deafening_blast"
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

new (class AutoDodgerUtility {
	private readonly entry = Menu.AddEntry("mm44x")
	private readonly node = this.entry.AddNode("Auto Dodger")
	private readonly enabled = this.node.AddToggle("Enabled", true)

	// Items settings
	private readonly itemsNode = this.node.AddNode("Items")
	private readonly itemsSelector = this.itemsNode.AddImageSelector(
		"Dodge Items",
		[
			"item_manta",
			"item_cyclone",
			"item_blade_mail",
			"item_black_king_bar"
		],
		new Map([
			["item_manta", true],
			["item_cyclone", true],
			["item_blade_mail", true],
			["item_black_king_bar", true]
		]),
		"Enable or disable specific items for dodging",
		true
	)

	// Hero Spells settings
	private readonly heroSpellsNode = this.node.AddNode("Hero Spells")
	private readonly heroSpellsSelector = this.heroSpellsNode.AddImageSelector(
		"Dodge Spells",
		[
			"puck_phase_shift",
			"nyx_assassin_spiked_carapace"
		],
		new Map([
			["puck_phase_shift", true],
			["nyx_assassin_spiked_carapace", true]
		]),
		"Enable or disable specific hero spells for dodging",
		true
	)

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

	private get hasLocalHero() {
		return LocalPlayer?.Hero !== undefined
	}

	private hasFatalDebuff(unit: Hero): boolean {
		return FATAL_MODIFIERS.some(mod => unit.HasBuffByName(mod))
	}

	private getThreatProjectileTimeToImpact(target: Hero): number {
		let minTime = Infinity
		
		// 1. Tracking Projectiles
		for (const proj of ProjectileManager.AllTrackingProjectiles) {
			if (proj.Target === target && proj.Ability) {
				const name = proj.Ability.Name
				if (
					MAGIC_THREAT_ABILITIES.includes(name) ||
					THREAT_ABILITIES.includes(name)
				) {
					const dist = proj.Position.Distance2D(target.Position)
					const timeToImpact = dist / Math.max(1, proj.Speed)
					if (timeToImpact < minTime) {
						minTime = timeToImpact
					}
				}
			}
		}

		// 2. Linear Projectiles
		for (const proj of ProjectileManager.AllLinearProjectiles) {
			if (proj.Ability && (MAGIC_THREAT_ABILITIES.includes(proj.Ability.Name) || THREAT_ABILITIES.includes(proj.Ability.Name))) {
				// Calculate distance of point to line segment
				const p = target.Position
				const a = proj.Position
				const b = proj.TargetLoc
				
				const ab = new Vector3(b.x - a.x, b.y - a.y, b.z - a.z)
				const ap = new Vector3(p.x - a.x, p.y - a.y, p.z - a.z)
				
				const abLenSqr = ab.LengthSqr
				let t = 0
				if (abLenSqr > 0) {
					t = Math.max(0, Math.min(1, ap.Dot(ab) / abLenSqr))
				}
				
				const projection = a.Add(ab.MultiplyScalar(t))
				const distanceToPath = p.Distance2D(projection)
				
				const collisionSize = 125 // Rough collision radius
				if (distanceToPath < collisionSize + 24) { 
					// If the projectile has not passed the hero yet (or is close)
					const projToHeroDist = a.Distance2D(projection)
					if (t > 0 && t < 1) { 
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

	private getDangerAoEAnimations(target: Hero, allHeroes: Hero[]): Hero | null {
		const AOE_SPELLS = [
			"tidehunter_ravage",
			"enigma_black_hole",
			"magnataur_reverse_polarity",
			"faceless_void_chronosphere",
			"axe_berserkers_call",
			"earthshaker_echo_slam"
		]

		for (const enemy of allHeroes) {
			if (enemy && enemy.IsValid && enemy.IsAlive && enemy.IsEnemy(target) && !enemy.IsIllusion) {
				const spells = enemy.Spells.filter((s): s is Ability => s !== undefined)
				for (const abil of spells) {
					if (abil.IsInAbilityPhase && AOE_SPELLS.includes(abil.Name)) {
						const radius = abil.Name === "tidehunter_ravage" ? 1200 : 500
						if (enemy.Distance2D(target, true) <= radius) {
							return enemy
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
		const delay = GameState.InputLag * 1000 + Math.randomRange(50, 150)
		
		const timeToImpact = this.getThreatProjectileTimeToImpact(hero)
		const aoeThreat = this.getDangerAoEAnimations(hero, allHeroes)
		const inFatal = this.hasFatalDebuff(hero)

		const isDodgeNeeded = (timeToImpact <= GameState.InputLag + 0.1) || (aoeThreat !== null)
		const isEarlyDodgeNeeded = (timeToImpact <= GameState.InputLag + 0.3) || (aoeThreat !== null)

		// 1. Manta Style Dodge
		if (this.itemsSelector.IsEnabled("item_manta") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const manta = hero.GetItemByName("item_manta")
			if (manta && manta.CanBeUsable && manta.Cooldown <= 0.1 && hero.IsManaEnough(manta)) {
				if (isDodgeNeeded) {
					this.executeAndClaimOrder(() => hero.CastNoTarget(manta), delay)
					return
				}
			}
		}

		// 2. Puck Phase Shift
		if (this.heroSpellsSelector.IsEnabled("puck_phase_shift") && hero.Name === "npc_dota_hero_puck" && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed && !hero.IsSilenced) {
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

		// 3. Nyx Spiked Carapace
		if (this.heroSpellsSelector.IsEnabled("nyx_assassin_spiked_carapace") && hero.Name === "npc_dota_hero_nyx_assassin" && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed && !hero.IsSilenced) {
			const carapace = hero.GetAbilityByName("nyx_assassin_spiked_carapace")
			if (carapace && carapace.IsValid && carapace.Level > 0 && carapace.Cooldown <= 0.1 && hero.IsManaEnough(carapace)) {
				if (!hero.HasBuffByName("modifier_nyx_assassin_spiked_carapace")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(carapace), delay)
						return
					}
				}
			}
		}

		// 4. Blade Mail
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

		// 5. BKB (Black King Bar)
		if (this.itemsSelector.IsEnabled("item_black_king_bar") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const bkb = hero.GetItemByName("item_black_king_bar")
			if (bkb && bkb.CanBeUsable && bkb.Cooldown <= 0.1) {
				if (!hero.IsDebuffImmune) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastNoTarget(bkb), delay)
						return
					}
				}
			}
		}

		// 6. Eul's Scepter Self Dodge
		if (this.itemsSelector.IsEnabled("item_cyclone") && !hero.IsMuted && !hero.IsStunned && !hero.IsHexed) {
			const ww = hero.GetItemByName("item_wind_waker")
			const eul = hero.GetItemByName("item_cyclone")
			const cyclone = ww && ww.CanBeUsable && ww.Cooldown <= 0.1 && hero.IsManaEnough(ww) ? ww : (eul && eul.CanBeUsable && eul.Cooldown <= 0.1 && hero.IsManaEnough(eul) ? eul : undefined)
			
			if (cyclone) {
				if (!hero.HasBuffByName("modifier_euler_cyclone")) {
					if (isEarlyDodgeNeeded || inFatal) {
						this.executeAndClaimOrder(() => hero.CastTarget(cyclone, hero), delay)
						return
					}
				}
			}
		}

	}

	private GameEnded(): void {
		this.castSleeper.ResetTimer()
	}
})()
