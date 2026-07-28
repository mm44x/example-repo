# Graph Report - .  (2026-07-28)

## Corpus Check
- Corpus is ~35,083 words - fits in a single context window. You may not need a graph.

## Summary
- 415 nodes · 571 edges · 24 communities (18 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- TypeScript ESLint Rule Configurations
- Largo Hero Combo Handler
- Tinker Hero Combo Handler
- Auto Save Defensive Logic
- Package Dev Dependencies
- TypeScript Compiler Options
- Package Project Metadata
- ESLint Configuration Setup
- Auto Ban Match Helper
- Invoker Hero Combo Handler
- Rubick Spell Steal Combo
- Strict TypeScript Lint Rules
- Last Hit Auto Creep Farming
- Anti Initiation Defense Helper
- Code Formatting Lint Rules
- Armlet Abuse Item Handler
- ESLint ID Denylist Definitions
- Member Delimiter Styling Rules
- Script Reference Architecture
- Octarine SDK Project Instructions
- Project Installation Setup
- SDK Event System Reference
- SDK Menu System Reference
- Humanizer Delay Pattern Reference

## God Nodes (most connected - your core abstractions)
1. `rules` - 125 edges
2. `PostDataUpdate()` - 20 edges
3. `executeOrbwalk()` - 17 edges
4. `compilerOptions` - 14 edges
5. `PostDataUpdate()` - 13 edges
6. `error` - 11 edges
7. `CustomLastHit` - 10 edges
8. `handleAutoFarm()` - 10 edges
9. `plugins` - 8 edges
10. `SmartArmletAbuse` - 8 edges

## Surprising Connections (you probably didn't know these)
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  invoker_combo.ts → orbwalker.ts
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  magnus_combo.ts → orbwalker.ts
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  rubick_combo.ts → orbwalker.ts
- `PostDataUpdate()` --calls--> `executeOrbwalk()`  [EXTRACTED]
  tinker_combo.ts → orbwalker.ts
- `executeAndClaimOrder()` --calls--> `claimOrder()`  [EXTRACTED]
  auto_save.ts → coordination.ts

## Import Cycles
- None detected.

## Communities (24 total, 6 thin omitted)

### Community 0 - "TypeScript ESLint Rule Configurations"
Cohesion: 0.02
Nodes (106): rules, block-spacing, comma-dangle, comma-spacing, complexity, constructor-super, dot-notation, eol-last (+98 more)

### Community 1 - "Largo Hero Combo Handler"
Cohesion: 0.09
Nodes (20): executeAutoRhapsodySpells(), executeComboAbility(), handleRhapsodySongHotkeys(), PostDataUpdate(), PostDataUpdate(), calcOrbwalkPosition(), executeOrbwalk(), OrbwalkConfig (+12 more)

### Community 2 - "Tinker Hero Combo Handler"
Cohesion: 0.14
Nodes (28): castNoTarget(), castPosition(), castTarget(), COMBO_SPELLS, debugSpellInfo, doBlink(), Draw(), drawPanel() (+20 more)

### Community 3 - "Auto Save Defensive Logic"
Cohesion: 0.15
Nodes (22): executeAndClaimOrder(), FATAL_MODIFIERS, getEnemyCasterOfThreat(), getOrderedAllies(), hasActiveSaveOrImmunity(), hasActiveThreatModifier(), hasFatalDebuff(), INSTANT_REFLECTABLE_SPELLS (+14 more)

### Community 4 - "Package Dev Dependencies"
Cohesion: 0.08
Nodes (25): eslint, eslint-config-prettier, eslint-plugin-import, eslint-plugin-jsdoc, eslint-plugin-prettier, eslint-plugin-simple-import-sort, eslint-plugin-unicorn, eslint-plugin-unused-imports (+17 more)

### Community 5 - "TypeScript Compiler Options"
Cohesion: 0.09
Nodes (22): ../../**/*.d.ts, ESNext, ./**/*.ts, compileOnSave, compilerOptions, alwaysStrict, baseUrl, experimentalDecorators (+14 more)

### Community 6 - "Package Project Metadata"
Cohesion: 0.09
Nodes (21): contributors, description, license, name, repository, directory, type, url (+13 more)

### Community 7 - "ESLint Configuration Setup"
Cohesion: 0.11
Nodes (19): env, es6, extends, ignorePatterns, node_modules/**/*, scripts_files/**/*, parser, parserOptions (+11 more)

### Community 8 - "Auto Ban Match Helper"
Cohesion: 0.18
Nodes (9): constructor(), isSelectionState(), onGameStateChanged(), onPostDataUpdate(), populateAndRefresh(), updateBans(), getHeroPrimaryAttribute(), PrepareUnitOrders() (+1 more)

### Community 9 - "Invoker Hero Combo Handler"
Cohesion: 0.24
Nodes (11): angleDifference(), castInvokerSpell(), executeComboAbility(), hasScepter(), invokeSpell(), isIceWallUpgraded(), isSunStrikeUpgraded(), PostDataUpdate() (+3 more)

### Community 10 - "Rubick Spell Steal Combo"
Cohesion: 0.23
Nodes (9): AbilityCooldownChanged(), executeStolenSpells(), getAdjustedRect(), IsAbilityVisibleOnHUD(), isValidSpell(), NATIVE_SPELLS, OnDraw(), OnMouseKeyDown() (+1 more)

### Community 11 - "Strict TypeScript Lint Rules"
Cohesion: 0.15
Nodes (13): eqeqeq, prettier/prettier, @typescript-eslint/array-type, @typescript-eslint/ban-types, @typescript-eslint/consistent-type-imports, @typescript-eslint/explicit-member-accessibility, @typescript-eslint/naming-convention, @typescript-eslint/no-shadow (+5 more)

### Community 12 - "Last Hit Auto Creep Farming"
Cohesion: 0.27
Nodes (3): CustomLastHit, lastHitSleeper, sleepTime()

### Community 13 - "Anti Initiation Defense Helper"
Cohesion: 0.27
Nodes (7): checkAndCastAntiInitiation(), Draw(), getCandidates(), getItemConfigs(), PostDataUpdate(), SpellConfig, SUPPORTED_SPELLS

### Community 14 - "Code Formatting Lint Rules"
Cohesion: 0.20
Nodes (10): arrow-parens, curly, func-style, object-curly-spacing, unused-imports/no-unused-vars, all, always, as-needed (+2 more)

### Community 16 - "ESLint ID Denylist Definitions"
Cohesion: 0.33
Nodes (6): id-denylist, any, Boolean, Number, String, Undefined

### Community 17 - "Member Delimiter Styling Rules"
Cohesion: 0.50
Nodes (5): one-var, @typescript-eslint/member-delimiter-style, @typescript-eslint/semi, never, off

### Community 18 - "Script Reference Architecture"
Cohesion: 0.67
Nodes (3): Entry Point Pattern, Lasthit Marker Reference, Snatcher Reference

## Knowledge Gaps
- **193 isolated node(s):** `root`, `node_modules/**/*`, `scripts_files/**/*`, `es6`, `parser` (+188 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `rules` connect `TypeScript ESLint Rule Configurations` to `ESLint Configuration Setup`, `Strict TypeScript Lint Rules`, `Code Formatting Lint Rules`, `ESLint ID Denylist Definitions`, `Member Delimiter Styling Rules`?**
  _High betweenness centrality (0.143) - this node is a cross-community bridge._
- **Why does `executeOrbwalk()` connect `Largo Hero Combo Handler` to `Invoker Hero Combo Handler`, `Rubick Spell Steal Combo`, `Tinker Hero Combo Handler`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `root`, `node_modules/**/*`, `scripts_files/**/*` to the rest of the system?**
  _193 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `TypeScript ESLint Rule Configurations` be split into smaller, more focused modules?**
  _Cohesion score 0.018867924528301886 - nodes in this community are weakly interconnected._
- **Should `Largo Hero Combo Handler` be split into smaller, more focused modules?**
  _Cohesion score 0.0915915915915916 - nodes in this community are weakly interconnected._
- **Should `Tinker Hero Combo Handler` be split into smaller, more focused modules?**
  _Cohesion score 0.14112903225806453 - nodes in this community are weakly interconnected._
- **Should `Package Dev Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._