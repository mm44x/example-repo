import {
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	LocalPlayer,
	Menu,
	TickSleeper
} from "github.com/octarine-public/wrapper/index"

import { claimOrder } from "./coordination"

new (class AutoDust {
	private readonly entry = Menu.AddEntry("mm44x")

	private readonly node = this.entry.AddNode("Auto Dust")
	private readonly enabled = this.node.AddToggle("Enabled", true)
	private readonly dustRange = this.node.AddSlider(
		"Trigger Range",
		1000,
		300,
		1100,
		0,
		"Only throw dust when the vanished enemy is within this distance (dust AoE radius is 1050)"
	)
	private readonly whileInvisible = this.node.AddToggle(
		"Auto Dust While Invisible",
		false,
		"When ON, still auto-dust even if your own hero is currently invisible (dust does not break invisibility)"
	)

	// Visibility tracking states
	private readonly enemyVisibility = new Map<number, boolean>()
	private readonly dustSleeper = new TickSleeper()

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("GameEnded", this.GameEnded.bind(this))
	}

	private get hasLocalHero() {
		return LocalPlayer?.Hero !== undefined
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (hero === undefined || !hero.IsValid || !hero.IsAlive) {
			return
		}

		const canAct =
			this.enabled.value &&
			!this.dustSleeper.Sleeping &&
			!hero.IsChanneling &&
			!hero.IsMuted &&
			!hero.IsStunned &&
			!hero.IsHexed &&
			// Respect the "cast while invisible" toggle
			(!hero.IsInvisible || this.whileInvisible.value)

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (!enemy?.IsValid || !enemy.IsEnemy(hero) || enemy.IsIllusion) {
				continue
			}

			const isVisible = enemy.IsVisible && enemy.IsAlive
			const wasVisible = this.enemyVisibility.get(enemy.Index) ?? false

			// Visible -> suddenly invisible => candidate for dust,
			// but only when the enemy is actually inside dust range.
			if (
				canAct &&
				wasVisible &&
				!isVisible &&
				enemy.IsAlive &&
				enemy.Distance2D(hero, true) <= this.dustRange.value
			) {
				this.tryCastDust(hero)
			}

			this.enemyVisibility.set(enemy.Index, isVisible)
		}
	}

	private tryCastDust(hero: Hero): void {
		const dust = hero.GetItemByName("item_dust")
		if (!dust || !dust.IsValid || !dust.CanBeUsable || dust.Cooldown > 0.1 || !hero.IsManaEnough(dust)) {
			return
		}

		hero.CastNoTarget(dust)
		claimOrder()
		this.dustSleeper.Sleep(GameState.InputLag * 1000 + Math.randomRange(50, 150))
	}

	private GameEnded(): void {
		this.enemyVisibility.clear()
		this.dustSleeper.ResetTimer()
	}
})()
