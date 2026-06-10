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
	Vector2
} from "github.com/octarine-public/wrapper/index"

class SmartArmletAbuse {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Smart Armlet Abuse")

	private readonly enabled = this.entry.AddToggle("Enabled", true)
	private readonly toggleKey = this.entry.AddKeybind("Toggle Keybind", "None", "Toggle script enabled/disabled state")
	private readonly toggleMode = this.entry.AddDropdown("Toggle Mode", ["Instant (Queued)", "Tick-by-Tick"], 0)

	// Safety Options
	private readonly safetyNode = this.entry.AddNode("Safety Settings", "", "", -1, 1)
	private readonly checkProjectiles = this.safetyNode.AddToggle("Check Tracking Projectiles", true)
	private readonly checkAnimations = this.safetyNode.AddToggle("Check Enemy Attack Animations", true)
	private readonly projectileBuffer = this.safetyNode.AddSlider("Projectile Buffer Time (ms)", 250, 100, 1000)
	private readonly attackBuffer = this.safetyNode.AddSlider("Attack Animation Buffer Time (ms)", 350, 100, 1000)

	private readonly hpThreshold = this.entry.AddSlider("HP Threshold to Toggle", 250, 50, 400, 0, "", 2)
	private readonly debugDraw = this.entry.AddToggle("Draw Debug Info", true, "", 3)

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

	private get hasLocalHero() {
		return LocalPlayer?.Hero !== undefined
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

		const armlet = hero.Items.find(item => item.Name === "item_armlet")
		if (!armlet || !armlet.IsValid) {
			return
		}

		const hasUnholyStrength = hero.Buffs.some(buff => buff.Name === "modifier_item_armlet_unholy_strength")

		// If Tick-by-Tick is waiting for off state
		if (this.toggleMode.SelectedID === 1 && this.isWaitingForOff) {
			if (GameState.RawGameTime - this.lastToggleTime > 1.0) {
				// Timeout safety mechanism
				this.isWaitingForOff = false
				return
			}
			if (!hasUnholyStrength) {
				// Modifier is gone, turn it back on immediately
				this.executeToggle(hero, armlet, false)
				this.isWaitingForOff = false
				this.sleeper.Sleep(800)
			}
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		// If armlet is OFF, and we are below threshold, turn it ON!
		const threshold = Math.min(this.hpThreshold.value, 350)
		if (!hasUnholyStrength) {
			if (hero.HP <= threshold) {
				this.executeToggle(hero, armlet, false)
				this.sleeper.Sleep(800)
			}
			return
		}

		// Check health threshold
		if (hero.HP > threshold) {
			return
		}

		// Safety Checks
		if (this.isThreatPresent(hero)) {
			return
		}

		// Perform toggle
		if (this.toggleMode.SelectedID === 0) {
			// Instant (Queued) Mode: Toggle Off and Toggle On in the same frame
			this.executeToggle(hero, armlet, false)
			this.executeToggle(hero, armlet, true)
			this.sleeper.Sleep(800)
		} else {
			// Tick-by-Tick Mode: Toggle Off, then wait for modifier to disappear
			this.executeToggle(hero, armlet, false)
			this.isWaitingForOff = true
			this.lastToggleTime = GameState.RawGameTime
		}
	}

	private isThreatPresent(hero: Hero): boolean {
		const now = GameState.RawGameTime

		// 1. Check Tracking Projectiles
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
				if (timeToImpact <= bufferTime) {
					return true
				}
			}
		}

		// 2. Check Enemy Attack Animations
		if (this.checkAnimations.value) {
			const enemies = EntityManager.GetEntitiesByClass(Unit).filter(
				u => u.IsValid && u.IsAlive && u.IsEnemy(hero) && u.IsVisible
			)
			for (const enemy of enemies) {
				if (enemy.Target?.Index !== hero.Index) {
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
					if (timeToHit >= -0.05 && timeToHit <= bufferTime) {
						return true
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
	}

	private Draw(): void {
		if (ExecuteOrder.DisableHumanizer || !this.hasLocalHero || !this.debugDraw.value) {
			return
		}
		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		let y = 300
		RendererSDK.Text("--- Smart Armlet Abuse ---", new Vector2(50, y), Color.Yellow)
		y += 20

		if (!this.enabled.value) {
			RendererSDK.Text("Status: DISABLED", new Vector2(50, y), Color.Red)
			return
		}

		const armlet = hero.Items.find(item => item.Name === "item_armlet")
		if (!armlet || !armlet.IsValid) {
			RendererSDK.Text("Armlet: NOT FOUND", new Vector2(50, y), Color.Red)
			return
		}

		const hasUnholyStrength = hero.Buffs.some(buff => buff.Name === "modifier_item_armlet_unholy_strength")
		RendererSDK.Text(
			`Armlet: FOUND | Unholy Strength: ${hasUnholyStrength ? "ACTIVE" : "INACTIVE"}`,
			new Vector2(50, y),
			Color.Green
		)
		y += 20

		RendererSDK.Text(
			`HP: ${hero.HP}/${hero.MaxHP} (Threshold: ${this.hpThreshold.value})`,
			new Vector2(50, y),
			Color.White
		)
		y += 20

		// Threat info
		const now = GameState.RawGameTime
		let threatInfo = "None"
		let threatColor = Color.Green

		// Check projectiles
		const projectiles = ProjectileManager.AllTrackingProjectiles
		for (const proj of projectiles) {
			if (!proj.IsValid || proj.IsDodged || !proj.Target || proj.Target.Index !== hero.Index) {
				continue
			}
			const dist = hero.Distance2D(proj.Position)
			const speed = proj.Speed > 0 ? proj.Speed : 1000
			const timeToImpact = dist / speed
			const bufferTime = this.projectileBuffer.value / 1000
			if (timeToImpact <= bufferTime) {
				threatInfo = `Projectile (Impact in ${timeToImpact.toFixed(2)}s, Buffer: ${bufferTime}s)`
				threatColor = Color.Red
				break
			}
		}

		if (threatInfo === "None") {
			// Check attack animations
			const enemies = EntityManager.GetEntitiesByClass(Unit).filter(
				u => u.IsValid && u.IsAlive && u.IsEnemy(hero) && u.IsVisible
			)
			for (const enemy of enemies) {
				if (enemy.Target?.Index !== hero.Index) {
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
					if (timeToHit >= -0.05 && timeToHit <= bufferTime) {
						threatInfo = `Attack from ${enemy.Name} (Hit in ${timeToHit.toFixed(
							2
						)}s, Buffer: ${bufferTime}s)`
						threatColor = Color.Red
						break
					}
				}
			}
		}

		RendererSDK.Text(`Active Threat: ${threatInfo}`, new Vector2(50, y), threatColor)
		y += 20
	}

	private GameEnded(): void {
		this.sleeper.ResetTimer()
		this.isWaitingForOff = false
		this.lastToggleTime = 0
	}
}

new SmartArmletAbuse()
