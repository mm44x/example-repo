import {
	Ability,
	Color,
	DOTA_ABILITY_BEHAVIOR,
	dotaunitorder_t,
	EntityManager,
	EventsSDK,
	ExecuteOrder,
	GameState,
	GUIInfo,
	Hero,
	ImageData,
	InputEventSDK,
	InputManager,
	LocalPlayer,
	Menu,
	Rectangle,
	RendererSDK,
	TickSleeper,
	Vector2,
	VKeys,
	VMouseKeys
} from "github.com/octarine-public/wrapper/index"
import { executeOrbwalk, type OrbwalkConfig } from "./orbwalker"

const NATIVE_SPELLS = [
	"rubick_telekinesis",
	"rubick_telekinesis_land",
	"rubick_telekinesis_land_self",
	"rubick_fade_bolt",
	"rubick_empty1",
	"rubick_empty2",
	"rubick_spell_steal",
	"rubick_hidden1",
	"rubick_hidden2",
	"rubick_hidden3",
	"rubick_arcane_supremacy",
	"rubick_might_and_magus",
	"generic_hidden",
	"attribute_bonus"
]

new (class RubickCombo {
	private readonly entry = Menu.AddEntry("mm44x").AddNode("Rubick Combo")

	private readonly comboKey = this.entry.AddKeybind("Combo Key", "F", "Hold to execute Rubick combo")
	private readonly comboRadius = this.entry.AddSlider("Target Search Radius", 800, 300, 1500)
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
		5,
		"Target distance percentage of attack range to maintain during Orb Walk"
	)
	private readonly smartOrbWalkStopCancel = this.entry.AddToggle(
		"Stop-to-Cancel Backswing",
		false,
		"Use STOP before moving during backswing cancel for crisper animation break on some heroes"
	)

	private readonly autoStealNode = this.entry.AddNode("Auto Steal Spells (Background)")
	private readonly autoStealEnabled = this.autoStealNode.AddToggle("Enabled", true)
	private autoStealGrid: any

	private readonly autoStealHudNode = this.autoStealNode.AddNode("Floating HUD Panel")
	private readonly autoStealHudEnabled = this.autoStealHudNode.AddToggle("Show HUD Panel", true)
	private readonly autoStealHudKey = this.autoStealHudNode.AddKeybind(
		"Toggle HUD Key",
		"None",
		"Key to toggle HUD panel visibility"
	)
	private readonly autoStealHudX = this.autoStealHudNode.AddSlider("HUD Position X", 400, 0, 2500)
	private readonly autoStealHudY = this.autoStealHudNode.AddSlider("HUD Position Y", 200, 0, 2500)
	private readonly autoStealHudIconSize = this.autoStealHudNode.AddSlider("HUD Icon Size", 36, 20, 80)

	private readonly autoCastNode = this.entry.AddNode("Stolen Spells Auto-Cast")
	private autoCastGrid: any

	private readonly hudOffsetNode = this.entry.AddNode("HUD Adjustments (Resolution Fix)")
	private readonly hudOffsetX = this.hudOffsetNode.AddSlider("X Offset", 0, -100, 100)
	private readonly hudOffsetY = this.hudOffsetNode.AddSlider("Y Offset", 0, -100, 100)
	private readonly hudSizeW = this.hudOffsetNode.AddSlider("Width Offset", 0, -50, 50)
	private readonly hudSizeH = this.hudOffsetNode.AddSlider("Height Offset", 0, -50, 50)

	private comboSequenceGrid: any

	private readonly sleeper = new TickSleeper()
	private readonly stealSleeper = new TickSleeper()

	private isDraggingHud = false
	private dragOffsetX = 0
	private dragOffsetY = 0
	private dragSpellName: string | undefined = undefined

	constructor() {
		this.autoStealGrid = this.autoStealNode.AddDynamicImageSelector("Spells", [], new Map())
		this.autoCastGrid = this.autoCastNode.AddDynamicImageSelector("Spells", [], new Map())

		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("rubick_telekinesis", [true, true, true, 0])
		defaultCombo.set("rubick_fade_bolt", [true, true, true, 1])
		defaultCombo.set("rubick_spell_steal", [true, true, true, 2])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			["rubick_telekinesis", "rubick_fade_bolt", "rubick_spell_steal"],
			defaultCombo
		)

		this.autoStealHudKey.OnPressed(() => {
			this.autoStealHudEnabled.value = !this.autoStealHudEnabled.value
			Menu.Base.SaveConfigASAP = true
		})

		EventsSDK.on("PostDataUpdate", this.PostDataUpdate.bind(this))
		EventsSDK.on("AbilityCooldownChanged", this.AbilityCooldownChanged.bind(this))
		InputEventSDK.on("MouseKeyDown", this.OnMouseKeyDown.bind(this))
		InputEventSDK.on("MouseKeyUp", this.OnMouseKeyUp.bind(this))
		EventsSDK.on("Draw", this.OnDraw.bind(this))
		EventsSDK.on("GameEnded", this.onGameEnded.bind(this))
	}

	private onGameEnded(): void {
		this.sleeper.Sleep(0)
		this.stealSleeper.Sleep(0)
		this.autoStealGrid = null
		this.autoCastGrid = null
		this.comboSequenceGrid = null
		this.isDraggingHud = false
		this.dragSpellName = undefined
		// Reinitialize grids for the next game
		this.reinitializeGrids()
	}

	private reinitializeGrids(): void {
		this.autoStealGrid = this.autoStealNode.AddDynamicImageSelector("Spells", [], new Map())
		this.autoCastGrid = this.autoCastNode.AddDynamicImageSelector("Spells", [], new Map())

		const defaultCombo = new Map<string, [boolean, boolean, boolean, number]>()
		defaultCombo.set("rubick_telekinesis", [true, true, true, 0])
		defaultCombo.set("rubick_fade_bolt", [true, true, true, 1])
		defaultCombo.set("rubick_spell_steal", [true, true, true, 2])

		this.comboSequenceGrid = this.entry.AddDynamicImageSelector(
			"Combo Order",
			["rubick_telekinesis", "rubick_fade_bolt", "rubick_spell_steal"],
			defaultCombo
		)
	}

	private IsAbilityVisibleOnHUD(abil: Ability | undefined): abil is Ability {
		return abil !== undefined && abil.IsValid && !abil.IsHidden && abil.ShouldBeDrawable
	}

	private getAdjustedRect(rect: Rectangle): Rectangle {
		const adjusted = rect.Clone()
		const ox = this.hudOffsetX.value
		const oy = this.hudOffsetY.value
		const ow = this.hudSizeW.value
		const oh = this.hudSizeH.value

		adjusted.pos1.x += ox
		adjusted.pos1.y += oy
		adjusted.pos2.x += ox + ow
		adjusted.pos2.y += oy + oh

		return adjusted
	}

	private executeStolenSpells(
		stolenSpells: Ability[],
		hero: Hero,
		bestTarget: Hero,
		isTargetImmune: boolean
	): boolean {
		for (const stolenSpell of stolenSpells) {
			if (
				stolenSpell &&
				stolenSpell.IsValid &&
				stolenSpell.Cooldown <= 0.1 &&
				hero.Mana >= stolenSpell.ManaCost &&
				!isTargetImmune
			) {
				if (!this.autoCastGrid) return false
				if (this.autoCastGrid.IsEnabled(stolenSpell.Name)) {
					const isTarget = stolenSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)
					const isPosition = stolenSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)
					const isNoTarget = stolenSpell.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)

					const castRange = stolenSpell.CastRange > 0 ? stolenSpell.CastRange : 600

					if (isNoTarget && hero.Distance2D(bestTarget) <= castRange) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_NO_TARGET,
							issuers: [hero],
							ability: stolenSpell.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + stolenSpell.CastPoint * 1000 + 100)
						return true
					} else if (isPosition && hero.Distance2D(bestTarget) <= castRange) {
						const castPos = bestTarget.Position.Clone()
						castPos.z = WorldUtils.GetHeightForLocation(castPos.x, castPos.y)

						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_POSITION,
							issuers: [hero],
							position: castPos,
							ability: stolenSpell.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + stolenSpell.CastPoint * 1000 + 100)
						return true
					} else if (isTarget && hero.Distance2D(bestTarget) <= castRange) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: stolenSpell.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + stolenSpell.CastPoint * 1000 + 100)
						return true
					}
				}
			}
		}
		return false
	}

	private OnDraw(): void {
		if (!this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Ensure grids are initialized
		if (!this.autoStealGrid || !this.autoCastGrid || !this.comboSequenceGrid) {
			return
		}

		// ------------------ FLOATING HUD PANEL DRAGGING ------------------
		if (this.autoStealHudEnabled.value && this.isDraggingHud) {
			const cursorPos = InputManager.CursorOnScreen
			const newX = cursorPos.x - this.dragOffsetX
			const newY = cursorPos.y - this.dragOffsetY

			this.autoStealHudX.value = Math.max(0, Math.round(newX))
			this.autoStealHudY.value = Math.max(0, Math.round(newY))
		}

		const hud = GUIInfo.GetLowerHUDForUnit(hero)
		if (hud && hud.AbilitiesRects) {
			let visibleIndex = 0
			for (const abil of hero.Spells) {
				if (this.IsAbilityVisibleOnHUD(abil)) {
					if (this.autoCastGrid && this.autoCastGrid.values.includes(abil.Name) && this.autoCastGrid.IsEnabled(abil.Name)) {
						if (visibleIndex < hud.AbilitiesRects.length) {
							const rect = this.getAdjustedRect(hud.AbilitiesRects[visibleIndex])

							// Inset the outline box by 2 pixels to fit nicely inside the ability icon slot
							const insetRect = rect.Clone()
							insetRect.pos1.x += 2
							insetRect.pos1.y += 2
							insetRect.pos2.x -= 2
							insetRect.pos2.y -= 2

							RendererSDK.OutlinedRect(insetRect.pos1, insetRect.Size, 2, Color.Green)

							// Calculate coordinates to center "AUTO" text at the bottom half of the ability slot
							const fontName = "PTSans"
							const fontSize = 11
							const fontWeight = 800
							const text = "AUTO"
							const textSize = RendererSDK.GetTextSize(text, fontName, fontSize, fontWeight, false)

							const textX = rect.pos1.x + (rect.Width - textSize.x) / 2
							const textY = rect.pos2.y - textSize.y - 4
							const textPos = new Vector2(textX, textY)

							// Draw semi-transparent black background behind text for readability
							const bgPaddingX = 4
							const bgPaddingY = 1
							const bgPos = new Vector2(textX - bgPaddingX, textY - bgPaddingY)
							const bgSize = new Vector2(textSize.x + bgPaddingX * 2, textSize.y + bgPaddingY * 2)
							RendererSDK.FilledRect(bgPos, bgSize, Color.Black.SetA(180))

							RendererSDK.Text(text, textPos, Color.Green, fontName, fontSize, fontWeight, false, true)
						}
					}

					if (abil.Name === "kez_switch_weapons") {
						visibleIndex += 2
					} else {
						visibleIndex++
					}
				}
			}
		}

		// ------------------ FLOATING HUD PANEL ------------------
		if (this.autoStealHudEnabled.value) {
			if (!this.autoStealGrid) return
			const values = this.autoStealGrid.values
			const iconSize = this.autoStealHudIconSize.value
			const gap = 6
			const cols = 5

			const N = values.length

			const panelX = this.autoStealHudX.value
			const panelY = this.autoStealHudY.value

			const rows = Math.max(1, Math.ceil(N / cols))
			const panelWidth = Math.max(150, Math.min(N > 0 ? N : cols, cols) * (iconSize + gap) + gap)
			const headerHeight = 22
			const panelHeight = headerHeight + rows * (iconSize + gap) + gap

			const panelPos = new Vector2(panelX, panelY)
			const panelSize = new Vector2(panelWidth, panelHeight)

			// 1. Draw Panel Background (semi-transparent dark with white outline)
			RendererSDK.FilledRect(panelPos, panelSize, Color.Black.SetA(160))
			RendererSDK.OutlinedRect(panelPos, panelSize, 1, Color.White.SetA(60))

			// 2. Draw Header Bar & Title
			const headerRectSize = new Vector2(panelWidth, headerHeight)
			RendererSDK.FilledRect(panelPos, headerRectSize, Color.Black.SetA(200))
			RendererSDK.OutlinedRect(panelPos, headerRectSize, 1, Color.White.SetA(60))

			const fontName = "PTSans"
			const fontSize = 11
			const fontWeight = 800
			const titleText = "AUTO STEAL PANEL"
			const titleTextSize = RendererSDK.GetTextSize(titleText, fontName, fontSize, fontWeight, false)
			const titleX = panelX + (panelWidth - titleTextSize.x) / 2
			const titleY = panelY + (headerHeight - titleTextSize.y) / 2
			RendererSDK.Text(
				titleText,
				new Vector2(titleX, titleY),
				Color.White,
				fontName,
				fontSize,
				fontWeight,
				false,
				true
			)

			// 3. Draw Spell Icons
			if (N === 0) {
				const noSpellsText = "No enemy spells detected"
				const noSpellsSize = RendererSDK.GetTextSize(noSpellsText, fontName, 10, 400, false)
				const nsX = panelX + (panelWidth - noSpellsSize.x) / 2
				const nsY = panelY + headerHeight + (panelHeight - headerHeight - noSpellsSize.y) / 2
				RendererSDK.Text(noSpellsText, new Vector2(nsX, nsY), Color.Gray, fontName, 10, 400, false, true)
			} else {
				for (let i = 0; i < N; i++) {
					const spellName = values[i]
					const col = i % cols
					const row = Math.floor(i / cols)

					const iconX = panelX + gap + col * (iconSize + gap)
					const iconY = panelY + headerHeight + gap + row * (iconSize + gap)
					const iconPos = new Vector2(iconX, iconY)
					const iconRectSize = new Vector2(iconSize, iconSize)

					const path = ImageData.GetSpellTexture(spellName)
					const isEnabled = this.autoStealGrid.IsEnabled(spellName)

					// Draw spell icon (grayscaled if disabled)
					RendererSDK.Image(path, iconPos, -1, iconRectSize, Color.White, 0, undefined, !isEnabled)

					// Draw border indicators (green if enabled, red if disabled)
					if (isEnabled) {
						RendererSDK.OutlinedRect(iconPos, iconRectSize, 2, Color.Green)
					} else {
						RendererSDK.OutlinedRect(iconPos, iconRectSize, 1, Color.Red.SetA(180))
					}

					// Draw priority number badge on top-left of the icon
					const prioText = `${i + 1}`
					const prioSize = RendererSDK.GetTextSize(prioText, fontName, 9, 800, false)
					const badgePaddingX = 3
					const badgePaddingY = 1

					const badgePos = new Vector2(iconX + 2, iconY + 2)
					const badgeSize = new Vector2(prioSize.x + badgePaddingX * 2, prioSize.y + badgePaddingY * 2)

					RendererSDK.FilledRect(badgePos, badgeSize, Color.Black.SetA(200))
					RendererSDK.OutlinedRect(
						badgePos,
						badgeSize,
						1,
						isEnabled ? Color.Green.SetA(150) : Color.Red.SetA(150)
					)
					RendererSDK.Text(
						prioText,
						new Vector2(badgePos.x + badgePaddingX, badgePos.y + badgePaddingY),
						Color.White,
						fontName,
						9,
						800,
						false,
						true
					)
				}
			}
		}

		// ------------------ FLOATING HUD PANEL DRAGGING SPELL ICON ------------------
		if (this.autoStealHudEnabled.value && this.dragSpellName !== undefined) {
			const cursorPos = InputManager.CursorOnScreen
			const iconSize = this.autoStealHudIconSize.value
			const path = ImageData.GetSpellTexture(this.dragSpellName)
			const dragIconPos = cursorPos.Subtract(new Vector2(iconSize / 2, iconSize / 2))
			const dragIconSize = new Vector2(iconSize, iconSize)

			RendererSDK.Image(path, dragIconPos, -1, dragIconSize, Color.White, 0, undefined, false)
			RendererSDK.OutlinedRect(dragIconPos, dragIconSize, 2, Color.Yellow)
		}
	}

	private OnMouseKeyDown(key: VMouseKeys): boolean | void {
		if (key !== VMouseKeys.MK_LBUTTON) {
			return
		}

		if (!this.hasLocalHero) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero) {
			return
		}

		const cursorPos = InputManager.CursorOnScreen

		// ------------------ FLOATING HUD PANEL CLICK INTERACTION ------------------
		if (this.autoStealHudEnabled.value) {
			if (!this.autoStealGrid) return
			const values = this.autoStealGrid.values
			const iconSize = this.autoStealHudIconSize.value
			const gap = 6
			const cols = 5

			const N = values.length
			const panelX = this.autoStealHudX.value
			const panelY = this.autoStealHudY.value

			const rows = Math.max(1, Math.ceil(N / cols))
			const panelWidth = Math.max(150, Math.min(N > 0 ? N : cols, cols) * (iconSize + gap) + gap)
			const headerHeight = 22
			const panelHeight = headerHeight + rows * (iconSize + gap) + gap

			// Bounding box of the floating panel
			const panelRect = new Rectangle(
				new Vector2(panelX, panelY),
				new Vector2(panelX + panelWidth, panelY + panelHeight)
			)

			if (panelRect.Contains(cursorPos)) {
				// Check if clicked on header for dragging
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

				// Check which spell icon was clicked
				const isCtrlHeld = InputManager.IsKeyDown(VKeys.CONTROL)
				for (let i = 0; i < N; i++) {
					const spellName = values[i]
					const col = i % cols
					const row = Math.floor(i / cols)

					const iconX = panelX + gap + col * (iconSize + gap)
					const iconY = panelY + headerHeight + gap + row * (iconSize + gap)

					const iconRect = new Rectangle(
						new Vector2(iconX, iconY),
						new Vector2(iconX + iconSize, iconY + iconSize)
					)

					if (iconRect.Contains(cursorPos)) {
						if (isCtrlHeld) {
							this.dragSpellName = spellName
						} else {
							if (this.autoStealGrid) {
								const enabledValues = this.autoStealGrid.enabledValues.get(spellName)
								if (enabledValues) {
									enabledValues[0] = !enabledValues[0]
									Menu.Base.SaveConfigASAP = true
								}
							}
						}
						break
					}
				}
				// Consume click event to prevent unit from moving in-game
				return true
			}
		}

		// ------------------ LOWER HUD SHIFT+CLICK INTERACTION ------------------
		if (!InputManager.IsKeyDown(16)) {
			// Shift key code
			return
		}

		const hud = GUIInfo.GetLowerHUDForUnit(hero)
		if (!hud || !hud.AbilitiesRects) {
			return
		}

		let clickedIndex = -1
		for (let i = 0; i < hud.AbilitiesRects.length; i++) {
			const adjustedRect = this.getAdjustedRect(hud.AbilitiesRects[i])
			if (adjustedRect.Contains(cursorPos)) {
				clickedIndex = i
				break
			}
		}

		if (clickedIndex !== -1) {
			let visibleIndex = 0
			for (const abil of hero.Spells) {
				if (this.IsAbilityVisibleOnHUD(abil)) {
					if (visibleIndex === clickedIndex) {
						if (this.autoCastGrid && this.autoCastGrid.values.includes(abil.Name)) {
							const enabledValues = this.autoCastGrid.enabledValues.get(abil.Name)
							if (enabledValues) {
								enabledValues[0] = !enabledValues[0]
								Menu.Base.SaveConfigASAP = true
							}
						}
						return true
					}

					if (abil.Name === "kez_switch_weapons") {
						visibleIndex += 2
					} else {
						visibleIndex++
					}
				}
			}
		}
	}

	private OnMouseKeyUp(key: VMouseKeys): boolean | void {
		if (key === VMouseKeys.MK_LBUTTON) {
			if (this.isDraggingHud) {
				this.isDraggingHud = false
				Menu.Base.SaveConfigASAP = true
				return true
			}

			if (this.dragSpellName !== undefined) {
				const dragSpellName = this.dragSpellName
				this.dragSpellName = undefined

				if (this.autoStealHudEnabled.value) {
					// Ensure autoStealGrid is initialized
					if (!this.autoStealGrid) {
						return true
					}

					const values = this.autoStealGrid.values
					const iconSize = this.autoStealHudIconSize.value
					const gap = 6
					const cols = 5

					const N = values.length
					const panelX = this.autoStealHudX.value
					const panelY = this.autoStealHudY.value
					const headerHeight = 22

					const cursorPos = InputManager.CursorOnScreen

					let targetSpellName: string | undefined
					for (let i = 0; i < N; i++) {
						const col = i % cols
						const row = Math.floor(i / cols)

						const iconX = panelX + gap + col * (iconSize + gap)
						const iconY = panelY + headerHeight + gap + row * (iconSize + gap)

						const iconRect = new Rectangle(
							new Vector2(iconX, iconY),
							new Vector2(iconX + iconSize, iconY + iconSize)
						)

						if (iconRect.Contains(cursorPos)) {
							targetSpellName = values[i]
							break
						}
					}

					if (targetSpellName !== undefined && targetSpellName !== dragSpellName) {
						const entries = [...this.autoStealGrid.enabledValues.entries()]
						entries.sort((a, b) => a[1][3] - b[1][3])

						const dragIdx = entries.findIndex(e => e[0] === dragSpellName)
						const targetIdx = entries.findIndex(e => e[0] === targetSpellName)

						if (dragIdx !== -1 && targetIdx !== -1) {
							const [dragged] = entries.splice(dragIdx, 1)
							entries.splice(targetIdx, 0, dragged)

							for (let k = 0; k < entries.length; k++) {
								entries[k][1][3] = k
							}

							this.autoStealGrid.Update()
							Menu.Base.SaveConfigASAP = true
						}
					}
				}
				return true
			}
		}
	}

	private get hasLocalHero() {
		return (
			LocalPlayer &&
			LocalPlayer.Hero &&
			LocalPlayer.Hero.IsValid &&
			LocalPlayer.Hero.Name === "npc_dota_hero_rubick"
		)
	}

	private isValidSpell(abil: Ability | undefined): abil is Ability {
		if (!abil || !abil.IsValid || abil.IsHidden || abil.IsItem) {
			return false
		}
		const name = abil.Name
		if (NATIVE_SPELLS.includes(name)) {
			return false
		}
		if (name.startsWith("special_bonus_")) {
			return false
		}
		if (name.includes("empty")) {
			return false
		}
		if (name === "plus_high_five" || name === "twin_gate_portal_warp") {
			return false
		}

		const isPassive = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_PASSIVE)
		const isNoTarget = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_NO_TARGET)
		const isTarget = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_UNIT_TARGET)
		const isPosition = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_POINT)
		const isToggle = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_TOGGLE)
		const isAutoCast = abil.HasBehavior(DOTA_ABILITY_BEHAVIOR.DOTA_ABILITY_BEHAVIOR_AUTOCAST)

		// Jika murni pasif (tanpa komponen aktif), tidak bisa dicuri
		if (isPassive && !isNoTarget && !isTarget && !isPosition && !isToggle && !isAutoCast) {
			return false
		}

		return true
	}

	private AbilityCooldownChanged(ability: Ability): void {
		if (!this.hasLocalHero || ExecuteOrder.DisableHumanizer || !this.autoStealEnabled.value) {
			return
		}

		if (!ability || !ability.IsValid || ability.IsItem || ability.Cooldown <= 1) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		const owner = ability.Owner
		if (!owner || !(owner instanceof Hero) || !owner.IsEnemy(hero) || owner.IsIllusion) {
			return
		}

		const spellName = ability.Name

		if (!this.autoStealGrid) return
		if (this.autoStealGrid.IsEnabled(spellName)) {
			const spellSteal = hero.GetAbilityByName("rubick_spell_steal")
			if (
				spellSteal &&
				spellSteal.IsValid &&
				spellSteal.Level > 0 &&
				spellSteal.Cooldown <= 0.1 &&
				hero.Mana >= spellSteal.ManaCost
			) {
				// --- GRID PRIORITY LOGIC ---
				const newSpellPriority = this.autoStealGrid.GetPriority(spellName)
				let shouldSteal = true
				let isUpgradingPriority = false

				// Cari tahu apakah kita sedang memegang spell curian
				for (const abil of hero.Spells) {
					if (this.isValidSpell(abil)) {
						const currentSpellPriority = this.autoStealGrid.GetPriority(abil.Name)

						// 1. Jangan pernah curi jika kita SUDAH memegang spell yang sama persis (mencegah spam)
						if (abil.Name === spellName) {
							shouldSteal = false
							break
						}

						// 2. Bandingkan Prioritas Grid UI
						// Nilai GetPriority() lebih KECIL = Posisi lebih di KIRI/ATAS = Prioritas lebih TINGGI
						// Jika spell yang sedang dipegang memiliki prioritas lebih tinggi (atau sama), JANGAN ditimpa!
						if (currentSpellPriority !== -1 && newSpellPriority >= currentSpellPriority) {
							shouldSteal = false
							break
						}

						// Jika spell baru memiliki prioritas lebih tinggi (angka lebih kecil), kita sedang UPGRADE spell!
						if (currentSpellPriority !== -1 && newSpellPriority < currentSpellPriority) {
							isUpgradingPriority = true
						}
					}
				}

				if (!shouldSteal) {
					return
				}
				// -------------------------

				// Prioritaskan eksekusi langsung jika ini adalah upgrade spell
				if (!this.stealSleeper.Sleeping || isUpgradingPriority) {
					const castRange = spellSteal.CastRange > 0 ? spellSteal.CastRange : 1000
					// Tambahkan batas toleransi jarak agar Rubick tidak berjalan melintasi map otomatis
					if (hero.Distance2D(owner) <= castRange + 400) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: owner.Index,
							ability: spellSteal.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						// Gunakan delay 0.8 detik agar cukup untuk mencegah spam brutal, namun cukup cepat di teamfight
						this.stealSleeper.Sleep(
							Math.max(800, GameState.InputLag * 1000 + spellSteal.CastPoint * 1000 + 100)
						)
					}
				}
			}
		}
	}

	private PostDataUpdate(delta: number): void {
		if (delta === 0 || !this.hasLocalHero || ExecuteOrder.DisableHumanizer) {
			return
		}

		const hero = LocalPlayer?.Hero
		if (!hero || !hero.IsValid || !hero.IsAlive) {
			return
		}

		// Ensure grids are initialized
		if (!this.autoStealGrid || !this.autoCastGrid || !this.comboSequenceGrid) {
			return
		}

		// Secara dinamis mendaftarkan spell musuh ke dalam menu Auto Steal
		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy && enemy.IsValid && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
				for (const abil of enemy.Spells) {
					if (this.isValidSpell(abil)) {
						if (!this.autoStealGrid.values.includes(abil.Name)) {
							this.autoStealGrid.OnAddNewImage(abil.Name, true, true)
						}
					}
				}
			}
		}

		// Secara dinamis mendaftarkan spell yang dicuri ke dalam menu
		const abilities = hero.Spells
		const stolenSpells: Ability[] = []

		for (const abil of abilities) {
			if (this.isValidSpell(abil)) {
				stolenSpells.push(abil)
				if (!this.autoCastGrid.values.includes(abil.Name)) {
					this.autoCastGrid.OnAddNewImage(abil.Name, true, true)
				}
			}
		}

		// Validasi apakah tombol combo ditekan
		// @ts-ignore
		if (!this.comboKey.isPressed) {
			return
		}

		if (hero.IsChanneling || hero.IsInvisible || hero.IsStunned || hero.IsSilenced || hero.IsHexed) {
			return
		}

		if (this.sleeper.Sleeping) {
			return
		}

		// Cari target hero musuh terdekat dengan posisi kursor mouse
		const mousePos = InputManager.CursorOnWorld
		let bestTarget: Hero | undefined
		let minDist = Infinity

		for (const enemy of EntityManager.GetEntitiesByClass(Hero)) {
			if (enemy.IsValid && enemy.IsAlive && enemy.IsVisible && enemy.IsEnemy(hero) && !enemy.IsIllusion) {
				const dist = enemy.Position.Distance2D(mousePos)
				if (dist < this.comboRadius.value && dist < minDist) {
					minDist = dist
					bestTarget = enemy
				}
			}
		}

		if (!bestTarget) {
			return
		}

		const isTargetImmune = bestTarget.IsMagicImmune || bestTarget.IsDebuffImmune

		let stolenSpellsExecuted = false

		// Urutan combo dinamis dari grid selector
		if (!this.comboSequenceGrid) return
		for (const spellName of this.comboSequenceGrid.values) {
			if (!this.comboSequenceGrid.IsEnabled(spellName)) {
				continue
			}

			if (spellName === "rubick_telekinesis") {
				// 1. Telekinesis
				const telekinesis = hero.GetAbilityByName("rubick_telekinesis")
				if (
					telekinesis &&
					telekinesis.IsValid &&
					telekinesis.Level > 0 &&
					telekinesis.Cooldown <= 0.1 &&
					hero.Mana >= telekinesis.ManaCost &&
					!isTargetImmune
				) {
					const castRange = telekinesis.CastRange > 0 ? telekinesis.CastRange : 600
					if (hero.Distance2D(bestTarget) <= castRange) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: telekinesis.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + telekinesis.CastPoint * 1000 + 100)
						return
					}
				}

				// Eksekusi Stolen Spells secara otomatis tepat setelah Telekinesis
				if (!stolenSpellsExecuted) {
					stolenSpellsExecuted = true
					if (this.executeStolenSpells(stolenSpells, hero, bestTarget, isTargetImmune)) {
						return
					}
				}
			} else if (spellName === "rubick_fade_bolt") {
				// Pastikan Stolen Spells dieksekusi jika belum sempat terpicu
				if (!stolenSpellsExecuted) {
					stolenSpellsExecuted = true
					if (this.executeStolenSpells(stolenSpells, hero, bestTarget, isTargetImmune)) {
						return
					}
				}

				// 3. Fade Bolt
				const fadeBolt = hero.GetAbilityByName("rubick_fade_bolt")
				if (
					fadeBolt &&
					fadeBolt.IsValid &&
					fadeBolt.Level > 0 &&
					fadeBolt.Cooldown <= 0.1 &&
					hero.Mana >= fadeBolt.ManaCost &&
					!isTargetImmune
				) {
					const castRange = fadeBolt.CastRange > 0 ? fadeBolt.CastRange : 800
					if (hero.Distance2D(bestTarget) <= castRange) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: fadeBolt.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + fadeBolt.CastPoint * 1000 + 100)
						return
					}
				}
			} else if (spellName === "rubick_spell_steal") {
				// Pastikan Stolen Spells dieksekusi jika belum sempat terpicu
				if (!stolenSpellsExecuted) {
					stolenSpellsExecuted = true
					if (this.executeStolenSpells(stolenSpells, hero, bestTarget, isTargetImmune)) {
						return
					}
				}

				// 4. Spell Steal
				const spellSteal = hero.GetAbilityByName("rubick_spell_steal")
				if (
					spellSteal &&
					spellSteal.IsValid &&
					spellSteal.Level > 0 &&
					spellSteal.Cooldown <= 0.1 &&
					hero.Mana >= spellSteal.ManaCost &&
					!isTargetImmune
				) {
					const castRange = spellSteal.CastRange > 0 ? spellSteal.CastRange : 1000
					if (hero.Distance2D(bestTarget) <= castRange) {
						ExecuteOrder.PrepareOrder({
							orderType: dotaunitorder_t.DOTA_UNIT_ORDER_CAST_TARGET,
							issuers: [hero],
							target: bestTarget.Index,
							ability: spellSteal.Index,
							queue: false,
							showEffects: true,
							isPlayerInput: false
						})
						this.sleeper.Sleep(GameState.InputLag * 1000 + spellSteal.CastPoint * 1000 + 100)
						return
					}
				}
			}
		}

		// Fallback terakhir untuk Stolen Spells jika semua skill lain dinonaktifkan di menu
		if (!stolenSpellsExecuted) {
			stolenSpellsExecuted = true
			if (this.executeStolenSpells(stolenSpells, hero, bestTarget, isTargetImmune)) {
				return
			}
		}

		// Fallback: Orb Walk / serang target via shared orbwalker
		executeOrbwalk(hero, bestTarget, this.sleeper, {
			enabled: this.smartOrbWalkEnabled.value,
			safeDistancePct: this.smartOrbWalkDistancePct.value,
			stopToCancel: this.smartOrbWalkStopCancel.value
		})
	}
})()
