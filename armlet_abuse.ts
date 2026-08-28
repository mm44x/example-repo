import {
	Color,
	dotaunitorder_t,
	EnableDisableUpdated,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	Item,
	LocalPlayer,
	Menu,
	modifierstate,
	NotificationsSDK,
	ProjectileManager,
	RendererSDK,
	TickSleeper,
	Unit,
	Vector2,
	Vector3
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"

const DEADLY_DOT_MODIFIERS = [
	"modifier_ice_blast",
	"modifier_doom_bringer_doom",
	"modifier_viper_poison_attack",
	"modifier_viper_viper_strike",
	"modifier_venomancer_poison_nova",
	"modifier_venomancer_venomous_gale",
	"modifier_venomancer_latent_poison",
	"modifier_pudge_rot",
	"modifier_item_radiance_debuff",
	"modifier_item_urn_damage",
	"modifier_item_spirit_vessel_damage",
	"modifier_jakiro_dual_breath_burn",
	"modifier_jakiro_macropyre",
	"modifier_jakiro_liquid_fire_burn",
	"modifier_jakiro_liquid_frost_burn",
	"modifier_huskar_burning_spear_debuff",
	"modifier_witch_doctor_maledict",
	"modifier_silencer_curse_of_the_silent",
	"modifier_alchemist_acid_spray",
	"modifier_rattletrap_battery_assault",
	"modifier_sand_king_sand_storm",
	"modifier_dark_seer_ion_shell",
	"modifier_shredder_chakram_debuff",
	"modifier_phoenix_fire_spirit_burn",
	"modifier_phoenix_supernova_radiance",
	"modifier_warlock_shadow_word",
	"modifier_ogre_magi_ignite",
	"modifier_batrider_sticky_napalm",
	"modifier_batrider_firefly"
]

const LINEAR_SKILLSHOTS = [
	"pudge_meat_hook",
	"mirana_arrow",
	"windrunner_powershot",
	"invoker_chaos_meteor",
	"invoker_deafening_blast",
	"invoker_sun_strike",
	"kunkka_torrent",
	"lina_light_strike_array",
	"leshrac_split_earth",
	"ancient_apparition_ice_blast"
]

class SmartArmletAbuse {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Smart Armlet Abuse")

	private readonly enabled = this.entry.AddToggle("Enabled", true, "Master toggle for Smart Armlet Abuse")
	private readonly toggleKey = this.entry.AddKeybind("Toggle Keybind", "None", "Toggle script enabled/disabled state")
	private readonly toggleMode = this.entry.AddDropdown(
		"Toggle Mode",
		["Instant (Queued)", "Tick-by-Tick"],
		0,
		"Instant is faster in single frame; Tick-by-Tick waits for modifier refresh"
	)

	private readonly hpThreshold = this.entry.AddSlider(
		"HP Threshold to Toggle",
		350,
		50,
		750,
		10,
		"HP under which to trigger armlet abuse"
	)
	private readonly toggleCooldown = this.entry.AddSlider(
		"Toggle Cooldown (ms)",
		320,
		200,
		600,
		10,
		"Interval between consecutive abuse toggles"
	)

	// Safety Options
	private readonly safetyNode = this.entry.AddNode("Safety Settings", "", "", -1, 1)
	private readonly checkDot = this.safetyNode.AddToggle(
		"Anti-Suicide DoT Guard",
		true,
		"Block toggling when active burn/poison/DoT debuff is ticking"
	)
	private readonly checkProjectiles = this.safetyNode.AddToggle(
		"Check Tracking Projectiles",
		true,
		"Check incoming targeted attack & spell projectiles"
	)
	private readonly checkLinearProjectiles = this.safetyNode.AddToggle(
		"Check Linear Skillshots",
		true,
		"Check incoming skillshot projectiles (Hook, Arrow, Powershot)"
	)
	private readonly checkAnimations = this.safetyNode.AddToggle(
		"Check Enemy Attack Animations",
		true,
		"Check hero attacks currently swinging at you"
	)
	private readonly checkCreepsTowers = this.safetyNode.AddToggle(
		"Check Creeps & Towers",
		true,
		"Prevent 1 HP death from nearby attacking creeps or towers"
	)
	private readonly projectileBuffer = this.safetyNode.AddSlider("Projectile Buffer Time (ms)", 250, 100, 800)
	private readonly attackBuffer = this.safetyNode.AddSlider("Attack Animation Buffer Time (ms)", 300, 100, 800)

	private readonly debugDraw = this.entry.AddToggle(
		"Draw Debug Info",
		true,
		"Display real-time Armlet status overlay",
		3
	)

	private readonly sleeper = new TickSleeper()
	private isWaitingForOff = false
	private lastToggleTime = 0

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("Draw", this.Draw.bind(this))
		EventsSDK.on("GameEnded", this.GameEnded.bind(this))

		this.toggleKey.OnPressed(() => {
			this.enabled.value = !this.enabled.value
			Menu.Base.SaveConfigASAP = true
			NotificationsSDK.Push(
				new EnableDisableUpdated(
					`Smart Armlet Abuse: ${this.enabled.value ? "ENABLED" : "DISABLED"}`,
					this.enabled.value ? Color.Green : Color.Red
				),
				true
			)
		})
	}

	private get hasLocalHero(): boolean {
		return LocalPlayer?.Hero !== undefined && LocalPlayer.Hero.IsValid === true
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || !this.enabled.value || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (hero === undefined || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Disable during basic disable states where items cannot be cast
		if (
			hero.IsMuted ||
			hero.IsStunned ||
			hero.IsHexed ||
			hero.IsNightmared ||
			hero.IsUnitStateFlagSet(modifierstate.MODIFIER_STATE_COMMAND_RESTRICTED)
		) {
			return
		}

		// Do not toggle inside fountain
		if (hero.Buffs.some(buff => buff.Name === "modifier_fountain_aura_buff")) {
			return
		}

		// Hard Blacklist: Ancient Apparition Ice Blast (0 HP gain from strength and instant shatter under threshold)
		if (hero.HasBuffByName("modifier_ice_blast")) {
			return
		}

		const armlet = hero.Items.find(item => item.Name === "item_armlet")
		if (!armlet || !armlet.IsValid || armlet.IsMuted) {
			return
		}

		const hasUnholyStrength = hero.Buffs.some(buff => buff.Name === "modifier_item_armlet_unholy_strength")

		// If Tick-by-Tick is waiting for off state
		if (this.toggleMode.SelectedID === 1 && this.isWaitingForOff) {
			if (GameState.RawGameTime - this.lastToggleTime > 0.8) {
				this.isWaitingForOff = false
				return
			}
			if (!hasUnholyStrength) {
				// Modifier is gone, turn it back on immediately
				this.executeToggle(hero, armlet, false)
				this.isWaitingForOff = false
				this.sleeper.Sleep(this.toggleCooldown.value)
			}
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		const threshold = this.hpThreshold.value

		// 1. Auto-Turn ON: If armlet is OFF, and we are below threshold or in combat, turn it ON immediately!
		if (!hasUnholyStrength) {
			if (hero.HP <= threshold || hero.IsAttacking || this.isEnemyNear(hero, 900)) {
				this.executeToggle(hero, armlet, false)
				this.sleeper.Sleep(this.toggleCooldown.value)
			}
			return
		}

		// 2. Check health threshold for abuse toggle
		if (hero.HP > threshold) {
			return
		}

		// 3. Safety Checks (DoT, Tracking Projectiles, Skillshots, Attack Animations)
		if (this.isThreatPresent(hero)) {
			return
		}

		// 4. Perform abuse toggle
		if (this.toggleMode.SelectedID === 0) {
			// Instant (Queued) Mode: Toggle Off and Toggle On in the same frame
			this.executeToggle(hero, armlet, false)
			this.executeToggle(hero, armlet, true)
			this.sleeper.Sleep(this.toggleCooldown.value)
		} else {
			// Tick-by-Tick Mode: Toggle Off, then wait for modifier to disappear
			this.executeToggle(hero, armlet, false)
			this.isWaitingForOff = true
			this.lastToggleTime = GameState.RawGameTime
		}
	}

	private isEnemyNear(hero: Hero, radius: number): boolean {
		const enemies = EntityManager.GetEntitiesByClass(Hero)
		return enemies.some(
			e => e && e.IsValid && e.IsAlive && e.IsEnemy(hero) && !e.IsIllusion && hero.Distance2D(e, true) <= radius
		)
	}

	private isThreatPresent(hero: Hero): boolean {
		const now = GameState.RawGameTime

		// 1. Anti-Suicide DoT Guard: Check active ticking damage modifiers
		if (this.checkDot.value) {
			const hasDeadlyDot = DEADLY_DOT_MODIFIERS.some(mod => hero.HasBuffByName(mod))
			if (hasDeadlyDot) {
				return true
			}
		}

		// 2. Check Tracking Projectiles (Hero attacks, Tower shots, Target spells)
		if (this.checkProjectiles.value) {
			const projectiles = ProjectileManager.AllTrackingProjectiles
			for (const proj of projectiles) {
				if (!proj.IsValid || proj.IsDodged || !proj.Target || proj.Target.Index !== hero.Index) {
					continue
				}
				const dist = hero.Distance2D(proj.Position)
				const speed = proj.Speed > 0 ? proj.Speed : 1000
				const timeToImpact = dist / speed
				const bufferTime = this.projectileBuffer.value / 1000
				if (timeToImpact <= bufferTime + GameState.InputLag) {
					return true
				}
			}
		}

		// 3. Check Linear Projectiles / Skillshots (Hook, Arrow, Powershot, etc.)
		if (this.checkLinearProjectiles.value) {
			for (const proj of ProjectileManager.AllLinearProjectiles) {
				if (!proj.Ability || !LINEAR_SKILLSHOTS.includes(proj.Ability.Name)) {
					continue
				}
				const p = hero.Position
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
						const bufferTime = this.projectileBuffer.value / 1000
						if (timeToImpact <= bufferTime + GameState.InputLag) {
							return true
						}
					}
				}
			}
		}

		// 4. Check Enemy Attack Animations (Heroes)
		if (this.checkAnimations.value) {
			const enemyHeroes = EntityManager.GetEntitiesByClass(Hero).filter(
				u => u.IsValid && u.IsAlive && u.IsEnemy(hero) && u.IsVisible && !u.IsIllusion
			)
			for (const enemy of enemyHeroes) {
				if (enemy.Target?.Index !== hero.Index && enemy.Distance2D(hero) > enemy.GetAttackRange(hero) + 150) {
					continue
				}

				if (enemy.IsInAnimation && enemy.LastAnimationIsAttack && !enemy.LastAnimationCasted) {
					const remainingTime = enemy.LastAnimationStartTime + enemy.LastAnimationCastPoint - now
					const travelTime = enemy.IsRanged
						? enemy.Distance2D(hero) /
						  (enemy.AttackProjectileSpeed > 0 ? enemy.AttackProjectileSpeed : 1000)
						: 0
					const timeToHit = remainingTime + travelTime
					const bufferTime = this.attackBuffer.value / 1000
					if (timeToHit >= -0.05 && timeToHit <= bufferTime + GameState.InputLag) {
						return true
					}
				}
			}
		}

		// 5. Check Nearby Creeps & Towers
		if (this.checkCreepsTowers.value && hero.HP <= 150) {
			const units = EntityManager.GetEntitiesByClass(Unit).filter(
				u => u.IsValid && u.IsAlive && u.IsEnemy(hero) && u.IsVisible && !(u instanceof Hero)
			)
			for (const unit of units) {
				const attackRange = unit.GetAttackRange(hero) || 150
				if (unit.Distance2D(hero) <= attackRange + 100) {
					if (unit.IsInAnimation && unit.LastAnimationIsAttack && !unit.LastAnimationCasted) {
						const remainingTime = unit.LastAnimationStartTime + unit.LastAnimationCastPoint - now
						if (remainingTime <= this.attackBuffer.value / 1000) {
							return true
						}
					}
				}
			}
		}

		return false
	}

	private executeToggle(hero: Hero, armlet: Item, queue: boolean): void {
		ExecuteOrder.PrepareOrder({
			orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TOGGLE,
			issuers: [hero],
			ability: armlet.Index,
			queue,
			isPlayerInput: false
		})
		claimOrder()
	}

	private Draw(): void {
		if (ExecuteOrder.DisableHumanizer || !this.hasLocalHero || !this.debugDraw.value) {
			return
		}
		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		const armlet = hero.Items.find(item => item.Name === "item_armlet")
		if (!armlet) {
			return
		}

		const x = 50
		let y = 350
		const padX = 8
		const padY = 6
		const textH = RendererSDK.DefaultTextSize

		const hasUnholyStrength = hero.Buffs.some(buff => buff.Name === "modifier_item_armlet_unholy_strength")
		const isDotActive = DEADLY_DOT_MODIFIERS.some(mod => hero.HasBuffByName(mod))
		const isThreat = this.isThreatPresent(hero)

		const lines = [
			`[Smart Armlet Abuse] ${this.enabled.value ? "ACTIVE" : "DISABLED"} (${
				this.toggleMode.SelectedID === 0 ? "Queued" : "Tick"
			})`,
			`  Unholy Strength: ${hasUnholyStrength ? "ON (+550 HP)" : "OFF"} | HP: ${hero.HP}/${
				hero.MaxHP
			} (Threshold: ${this.hpThreshold.value})`,
			`  Threat Status: ${isThreat ? "THREAT DETECTED (LOCKED)" : "SAFE TO TOGGLE"}`,
			`  DoT Guard: ${isDotActive ? "DANGER (DoT Active)" : "CLEAR"}`
		]

		let maxW = 0
		for (const line of lines) {
			const sz = RendererSDK.GetTextSize(line, RendererSDK.DefaultFontName, RendererSDK.DefaultTextSize)
			if (sz.x > maxW) {
				maxW = sz.x
			}
		}

		const rectW = maxW + padX * 2
		const rectH = lines.length * textH + padY * 2

		RendererSDK.FilledRect(new Vector2(x - padX, y - padY), new Vector2(rectW, rectH), new Color(0, 0, 0, 220))
		RendererSDK.OutlinedRect(
			new Vector2(x - padX, y - padY),
			new Vector2(rectW, rectH),
			1.5,
			isThreat ? new Color(255, 60, 60, 220) : new Color(60, 255, 60, 220)
		)

		for (let i = 0; i < lines.length; i++) {
			const col =
				i === 0
					? Color.Yellow
					: i === 2
					? isThreat
						? Color.Red
						: Color.Green
					: i === 3
					? isDotActive
						? Color.Red
						: Color.White
					: Color.White
			RendererSDK.Text(lines[i], new Vector2(x, y), col)
			y += textH
		}
	}

	private GameEnded(): void {
		this.sleeper.ResetTimer()
		this.isWaitingForOff = false
		this.lastToggleTime = 0
	}
}

new SmartArmletAbuse()
