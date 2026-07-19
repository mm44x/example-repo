import "./auto_ban"
import "./rubick_combo"
import "./last_hit"
import "./armlet_abuse"
import "./anti_initiation"
import "./auto_save"
import "./visage_combo"
import "./tusk_combo"
import "./magnus_combo"
import "./invoker_combo"


import {
	Attributes,
	dotaunitorder_t,
	EventsSDK,
	ExecuteOrder,
	GameState,
	Hero,
	item_power_treads,
	LocalPlayer,
	Menu,
	PowerTreadsAttribute,
	TickSleeper
} from "github.com/octarine-public/wrapper/index"

interface ScheduledSwitch {
	time: number
	attribute: PowerTreadsAttribute
}

new (class AutoBootsUtility {
	private readonly entry = Menu.AddEntry("mm44x")

	// Auto Boots Nodes
	private readonly bootsTree = this.entry.AddNode("Auto Boots")
	private readonly phaseEnabled = this.bootsTree.AddToggle("Auto Phase Boots", true)
	private readonly phaseSleeper = new TickSleeper()

	private readonly treadsEnabled = this.bootsTree.AddToggle("Auto Power Treads", true)
	private switchQueue: ScheduledSwitch[] = []

	constructor() {
		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("PrepareUnitOrders", this.PrepareUnitOrders.bind(this))
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

		// Process Power Treads scheduled switchbacks
		if (this.treadsEnabled.value && this.switchQueue.length > 0) {
			const now = GameState.RawGameTime
			const powerTreads = hero.Items.find(item => item.Name === "item_power_treads") as
				| item_power_treads
				| undefined
			if (powerTreads && powerTreads.IsValid) {
				while (this.switchQueue.length > 0 && this.switchQueue[0].time <= now) {
					const task = this.switchQueue.shift()
					if (task) {
						powerTreads.SwitchAttribute(task.attribute, false)
					}
				}
			} else {
				this.switchQueue = []
			}
		}

		// Auto Phase Boots logic
		if (this.phaseEnabled.value && !this.phaseSleeper.Sleeping) {
			// Do not cast if channeling (e.g. TP Scroll or channeling spells)
			if (hero.IsChanneling) {
				return
			}

			// Do not cast when invisible to avoid breaking invisibility
			if (hero.IsInvisible) {
				return
			}

			// Do not cast if already has Phase Boots active buff
			if (hero.Buffs.some(buff => buff.Name === "modifier_item_phase_boots_active")) {
				return
			}

			// Only cast when moving
			if (!hero.IsMoving) {
				return
			}

			const phaseBoots = hero.Items.find(item => item.Name === "item_phase_boots")
			if (phaseBoots) {
				const ready =
					phaseBoots.CanBeUsable &&
					!hero.IsMuted &&
					hero.Mana >= phaseBoots.ManaCost &&
					phaseBoots.Cooldown <= 0.1
				if (ready) {
					ExecuteOrder.PrepareOrder({
						orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
						issuers: [hero],
						ability: phaseBoots.Index,
						queue: false,
						showEffects: true,
						isPlayerInput: false
					})
					const delay = GameState.InputLag * 1000 + Math.randomRange(50, 150)
					this.phaseSleeper.Sleep(delay)
				}
			}
		}
	}

	private PrepareUnitOrders(order: ExecuteOrder) {
		if (!this.treadsEnabled.value) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Make sure the order is issued by our local hero (manual or script combo)
		if (!order.Issuers.includes(hero)) {
			return
		}

		const powerTreads = hero.Items.find(item => item.Name === "item_power_treads") as item_power_treads | undefined
		if (!powerTreads || !powerTreads.IsValid) {
			return
		}

		const primaryAttr = this.getHeroPrimaryAttribute(hero)

		// Stop or Hold orders => cancel any pending switch and revert immediately
		if (
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_STOP ||
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_HOLD_POSITION
		) {
			this.switchQueue = []
			powerTreads.SwitchAttribute(primaryAttr, false)
			return
		}

		// Spell cast orders => switch to INT, schedule switch back
		const isCastOrder =
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION ||
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET ||
			order.OrderType === dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET

		if (isCastOrder) {
			const ability = order.Ability_
			if (ability && typeof ability !== "number" && !ability.IsItem && ability.ManaCost > 0) {
				// Switch to INT immediately before the spell starts casting
				powerTreads.SwitchAttribute(PowerTreadsAttribute.INTELLIGENCE, false)

				// Schedule switch back after CastPoint + latency buffer (20ms)
				const readyTime = GameState.RawGameTime + ability.CastPoint + 0.02
				this.switchQueue = [{ time: readyTime, attribute: primaryAttr }]
			}
		}
	}

	private getHeroPrimaryAttribute(hero: Hero): PowerTreadsAttribute {
		const primary = hero.PrimaryAttribute
		switch (primary) {
			case Attributes.DOTA_ATTRIBUTE_STRENGTH:
				return PowerTreadsAttribute.STRENGTH
			case Attributes.DOTA_ATTRIBUTE_AGILITY:
				return PowerTreadsAttribute.AGILITY
			case Attributes.DOTA_ATTRIBUTE_INTELLECT:
				return PowerTreadsAttribute.INTELLIGENCE
			default:
				return PowerTreadsAttribute.STRENGTH
		}
	}

	private GameEnded(): void {
		this.phaseSleeper.ResetTimer()
		this.switchQueue = []
	}
})()
