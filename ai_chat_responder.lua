-- AI Chat Responder: listens to in-game chat and replies via an OpenAI-compatible
-- chat completions endpoint with a casual, encouraging persona.
---@diagnostic disable: undefined-global, param-type-mismatch, inject-field

local JSON = require("assets.JSON")

-- =============================================================================
-- Constants
-- =============================================================================

local DEFAULT_SYSTEM_PROMPT = [[You are an AI playing Dota 2, talking to other players in the game chat while you play. Reply in 1 or 2 short sentences, under 30 words total, lowercase, no emojis, no hashtags, no trailing periods at the end of the chat (real gamers do not put periods at the end of chat lines). Tone: calm, friendly, casual gamer, a little dry. Sound like a normal person playing Dota on PC. You may use common gaming shorthands (e.g. u, ur, ty, thx, gl, glhf, mb, np, sec, idk, lol, gg, wkwk) naturally when fitting.

ABSOLUTE RULE — TALK TO THEM, NOT ABOUT THEM: Chat is a direct conversation. ALWAYS reply in the second person ("you") as if you're talking directly to the players in the server. The history lines you see are formatted as "HeroName (nickname): message" — that label is ONLY so you know who spoke, it is NOT part of the message and you must NEVER repeat that label format. If players are talking to someone else or discussing other teammates, you CAN chime in and participate in the conversation, but ALWAYS speak directly to them (address the speaker or the hero they are talking to in the second person). Never narrate from the third person (forbidden patterns: "warlock is calling for...", "shaman asking about...", "riki calling me sad", "luna wants to...", "he/she said...", "X is tilted"). Just speak directly. Do not open by restating their message. Do not append generic filler about match state unless asked.

HERO STATUS AWARENESS: Your current hero status (Alive with HP% and Mana%, or DEAD with respawn seconds) is provided in the Game state. Be naturally aware of your condition: if you are DEAD, never say you are coming, fighting, or on your way (say you are dead/waiting for respawn); if you are low on HP or out of mana, react realistically if asked to fight.

LANGUAGE MATCHING — ALWAYS REPLY IN THE LANGUAGE THE PLAYER USED: Detect the language of the most recent player message and answer in that same language. If they write in Chinese, reply in Chinese. If they write in Tagalog/Filipino, reply in Tagalog. If they write in Russian, reply in Russian. Same for Spanish, Portuguese, Vietnamese, Thai, Indonesian/Malay, Korean, Japanese, Arabic, Turkish, German, French, Italian, Polish, Ukrainian, Hindi, or any other language. If the message is English or the language is unclear/mixed, reply in English. For romanized non-English (e.g. pinyin, romaji, taglish, singlish), mirror the same style they used. Do not translate or explain — just respond natively in their language. Keep the lowercase / no-emoji / no-hashtag / no trailing period rules regardless of language (for scripts without case like Chinese/Japanese/Arabic, just skip the lowercase rule).

ABSOLUTE RULE — NO GAMEPLAY ADVICE OR STRATEGY: Never suggest plays, items, builds, lane assignments, rotations, who to fight, when to push, when to back, when to ward, who to target, who to gank, what to farm, what to skill, or any tactic. Never analyze matchups, draft, hero strength, or "we win late / they're strong early" type takes. Never tell anyone where to go or what to do. Treat ALL gameplay topics as small talk only — react with a one-line acknowledgement, joke, or empty agreement, and propose nothing. The ONLY exception is if a player literally and explicitly asks you for advice (e.g. "what should I build?", "should I gank?"); ignore implicit hints, tilt-venting, complaints, status updates, or rhetorical questions.

Vary your openings — do NOT start every reply with "yeah" (or its equivalent in the target language). Avoid forced marketing hype slang ("lets gooo", "vibing", "we got this", "hyped af").

If someone insults you, trash-talks you, or tries to tilt you, engage in the banter — laugh it off and fire a light insult back. Keep it playful and witty, not cruel: punch at their gameplay, their ego, or the insult itself, not at protected characteristics. No slurs, no threats, no crude/sexual content. Think dry roast, not flamewar — one clean jab per reply, then move on. If they keep escalating, stay amused and unbothered rather than matching pure rage.
If someone sends crude/sexual bait or genuinely disturbing content, skip the banter and give a short dry deflection instead.
If a teammate seems tilted (venting at the game, not at you), one short reassuring line is enough — and still no strategy.
If asked what or who you are, or if you're a bot/AI, answer honestly that you're an AI playing the game.]]

local DEFAULT_BASE_URL  = "http://217.216.74.180:20128/v1"
local DEFAULT_MODEL     = "ag/gemini-3-flash"
local MAX_REPLY_CHARS   = 140
local MAX_TOKENS        = 150
local TEMPERATURE       = 0.8
local HISTORY_HARD_CAP  = 5000

local CH_ALL  = "DOTAChannelType_GameAll"
local CH_TEAM = "DOTAChannelType_GameAllies"

-- =============================================================================
-- State
-- =============================================================================

local lastReplyTime       = {}    -- [playerId] = float seconds
local localPlayerIdCache  = nil
local warnedNoKey         = false
local recentSelfReplies   = {}    -- ring of last N AI replies; echo of these is skipped
local RECENT_REPLY_KEEP   = 8     -- how many self-replies to remember
local chatHistory         = {}    -- rolling list of {role, content} sent to the model
local IGNORED_HEROES      = {}    -- [heroSlug] = true, tracked from MultiSelect
local isRequestInProgress = false -- prevent concurrent LLM requests
local outboxQueue         = {}    -- queue of { channel, text, sendAt, isLocal }
local lastChatSentTime    = 0     -- timestamp when last chat message was actually sent
local MIN_CHAT_INTERVAL   = 2.0   -- minimum seconds between any two outgoing chat messages

-- =============================================================================
-- Persona Presets
-- =============================================================================

local PERSONA_PROMPTS = {
    [0] = [[ACTIVE PERSONA — CHILL GAMER:
Tone: calm, friendly, relaxed, grounded. Play the game with good vibes, acknowledge teamwork with simple "ty", "wp", "no worries", or "my bad". Laugh off mistakes and keep things drama-free.]],

    [1] = [[ACTIVE PERSONA — TRASHTALKER / SAVAGE:
Tone: sarcastic, witty, confident, sharp. You love banter and counter-roasting. If an enemy dies, talks trash, or blunders, deliver a crisp, funny pub jab ("nice dive", "who told u to jump", "sit down", "was that intentional?", "free kill ty"). Never use slurs or real-life toxicity; stick to gameplay, ego, and pub banter. When your score is good, be smug; when behind, blame bad luck playfully.]],

    [2] = [[ACTIVE PERSONA — SEA PUB NATIVE (SOUTHEAST ASIA):
Tone: authentic SEA server pub culture. Expressive, funny, casual. You naturally mix in common SEA pub expressions and slang where fitting (e.g. "wkwk", "lah", "sia", "g", "end fast", "ez", "wala", "ggwp", "wait ah"). When teammates do well, hype them up; when enemies talk, tease them in classic SEA cafe style.]],

    [3] = [[ACTIVE PERSONA — TRYHARD / MINIMALIST:
Tone: ultra-compact, competitive, no-nonsense. You hate wasting time typing. Keep 90% of your replies under 5 words. Use gamer telegraphic shorthand: "k", "b", "ty", "sec", "wait bkb", "omw", "cd 20s", "push", "def", "my bad". Do not write long explanations.]],

    [4] = [[ACTIVE PERSONA — FUNNY / CLOWN (MEME & HUMOR):
Tone: hilarious, playful, self-deprecating, meme-loving gamer. You bring comic relief to the match.
- When you die, blunder, or get caught, give funny absurd excuses ("mouse gw keinjek kucing sry", "i was typing to my mom", "keyboard disconnected 2 sec", "tangan licin abis makan gorengan", "lag 9999 ping trust me", "ngetes angin doang tadi", "tadi udah janjian sama creep").
- When winning or making a play, use deadpan exaggeration ("calculated 100% no panic", "tutorial bot hard ini ya", "we are literally ti winners").
- When teammates or enemies question you or talk in chat, react with comedic pub wit ("bro thought he was him lmao", "jantung gw ketinggalan di fountain", "bjir", "awokawok", "santai ini baru pemanasan").
- Keep it lighthearted and comical, never genuinely hateful or toxic.]],
}

-- =============================================================================
-- Hero list for ignore feature
-- =============================================================================

local ALL_HEROES = {
    "antimage", "axe", "bane", "bloodseeker", "crystal_maiden", "drow_ranger",
    "earthshaker", "juggernaut", "mirana", "morphling", "nevermore", "phantom_lancer",
    "puck", "pudge", "razor", "sand_king", "storm_spirit", "sven", "tiny",
    "vengefulspirit", "windrunner", "zuus", "kunkka", "lina", "lion",
    "shadow_shaman", "slardar", "tidehunter", "witch_doctor", "riki",
    "enigma", "tinker", "sniper", "necrolyte", "warlock", "beastmaster",
    "queenofpain", "venomancer", "faceless_void", "skeleton_king", "death_prophet",
    "phantom_assassin", "pugna", "templar_assassin", "viper", "luna",
    "dragon_knight", "dazzle", "rattletrap", "leshrac", "furion",
    "life_stealer", "dark_seer", "clinkz", "omniknight", "enchantress",
    "huskar", "night_stalker", "broodmother", "bounty_hunter", "weaver",
    "jakiro", "batrider", "chen", "spectre", "doom_bringer", "ancient_apparition",
    "ursa", "spirit_breaker", "gyrocopter", "alchemist", "invoker",
    "silencer", "obsidian_destroyer", "lycan", "brewmaster", "shadow_demon",
    "lone_druid", "chaos_knight", "meepo", "treant", "ogre_magi",
    "undying", "rubick", "disruptor", "nyx_assassin", "naga_siren",
    "keeper_of_the_light", "wisp", "visage", "slark", "medusa",
    "troll_warlord", "centaur", "magnataur", "shredder", "bristleback",
    "tusk", "skywrath_mage", "abaddon", "elder_titan", "legion_commander",
    "ember_spirit", "earth_spirit", "terrorblade", "phoenix", "oracle",
    "winter_wyvern", "arc_warden", "abyssal_underlord", "monkey_king",
    "pangolier", "dark_willow", "grimstroke", "mars", "void_spirit",
    "snapfire", "hoodwink", "dawnbreaker", "marci", "primal_beast",
    "muerta", "ringmaster", "kez"
}

local function buildAllHeroItems()
    local items = {}
    for _, hero in ipairs(ALL_HEROES) do
        table.insert(items, {
            hero,
            "panorama/images/heroes/icons/npc_dota_hero_" .. hero .. "_png.vtex_c",
            IGNORED_HEROES[hero] == true
        })
    end
    return items
end

-- =============================================================================
-- Menu UI
-- =============================================================================

local tab = Menu.Create("Scripts", "User Scripts", "AI Chat Responder")
tab:Icon("\u{f086}") -- comments icon
local g = tab:Create("Main"):Create("AI Responder")

local ui = {}
ui.enabled  = g:Switch("Enable",                  false, "\u{f011}")
ui.persona  = g:Combo ("Persona Style",           {"Chill Gamer", "Trashtalker / Savage", "SEA Pub Native", "Tryhard / Minimalist", "Funny / Clown"}, 0)
ui.replySelf = g:Switch("Reply to my own chat",   false, "\u{f2bd}")
ui.channel  = g:Combo ("Listen Channel",          {"All chat", "Team chat", "Both"}, 2)
ui.cooldown = g:Slider("Per-player Cooldown (s)", 0, 30, 2, "%d s")
ui.history  = g:Slider("Context Messages",        0, HISTORY_HARD_CAP, 500, "%d msgs")
ui.ignoreList = g:MultiSelect("Ignore Heroes (no reply)", buildAllHeroItems(), false)

local lastMatchHeroes = {}

local function updateIgnoreListHeroes()
    local inGame = Engine and Engine.IsInGame and Engine.IsInGame()

    if not inGame then
        if #lastMatchHeroes > 0 then
            lastMatchHeroes = {}
            ui.ignoreList:Update(buildAllHeroItems(), false, false)
        end
        return
    end

    local heroes = Heroes and Heroes.GetAll and Heroes.GetAll()
    if not heroes or #heroes == 0 then
        return
    end

    local items = {}
    local seen = {}
    local currentSlugs = {}
    for _, h in ipairs(heroes) do
        if h then
            local unitName = NPC.GetUnitName and NPC.GetUnitName(h)
            if type(unitName) == "string" and unitName ~= "" then
                local slug = unitName:match("npc_dota_hero_(.+)") or unitName
                if not seen[slug] then
                    seen[slug] = true
                    table.insert(currentSlugs, slug)
                    table.insert(items, {
                        slug,
                        "panorama/images/heroes/icons/" .. unitName .. "_png.vtex_c",
                        IGNORED_HEROES[slug] == true
                    })
                end
            end
        end
    end

    table.sort(currentSlugs)
    local changed = (#currentSlugs ~= #lastMatchHeroes)
    if not changed then
        for i = 1, #currentSlugs do
            if currentSlugs[i] ~= lastMatchHeroes[i] then
                changed = true
                break
            end
        end
    end

    if changed and #items > 0 then
        lastMatchHeroes = currentSlugs
        ui.ignoreList:Update(items, false, false)
    end
end
ui.preset   = g:Combo ("API Preset",              {"Custom / OpenAI", "9router VPS"}, 1)
ui.baseUrl  = g:Input ("Base URL",                DEFAULT_BASE_URL)
ui.apiKey   = g:Input ("API Key",                 "")
ui.model    = g:Input ("Model",                   DEFAULT_MODEL)
ui.prompt    = g:Input ("System Prompt",           DEFAULT_SYSTEM_PROMPT)

ui.preset:SetCallback(function(this)
    local val = this:Get()
    if val == 1 then
        ui.baseUrl:Set("http://217.216.74.180:20128/v1")
        ui.model:Set("ag/gemini-3-flash")
    elseif val == 0 then
        ui.baseUrl:Set("https://api.openai.com/v1")
        ui.model:Set("gpt-4o-mini")
    end
end, false)

-- The cheat's Lua sandbox blocks os.execute and absolute paths outside the
-- cheat directory. The `configs/` folder is the one place reliably writable.
local PROMPT_FILE = "configs/ai_chat_prompt.txt"

ui.saveBtn   = g:Button("Save Prompt to File", function()
    local f, errOpen = io.open(PROMPT_FILE, "w")
    if not f then
        print("[AIChat] cannot write " .. PROMPT_FILE .. ": " .. tostring(errOpen))
        return
    end
    f:write(ui.prompt:Get() or "")
    f:close()
    print("[AIChat] saved prompt to " .. PROMPT_FILE)
    print("[AIChat] open <CheatFolder>/" .. PROMPT_FILE .. " in Notepad, edit, save, then click 'Apply Prompt from File'.")
end)

ui.applyBtn  = g:Button("Apply Prompt from File", function()
    local f, errOpen = io.open(PROMPT_FILE, "r")
    if not f then
        print("[AIChat] no file at " .. PROMPT_FILE .. " — click 'Save Prompt to File' first. (" .. tostring(errOpen) .. ")")
        return
    end
    local txt = f:read("*a")
    f:close()
    if type(txt) == "string" and txt ~= "" then
        ui.prompt:Set(txt)
        print("[AIChat] prompt updated from " .. PROMPT_FILE .. " (" .. #txt .. " chars)")
    else
        print("[AIChat] file empty, not applying")
    end
end)

ui.resetBtn  = g:Button("Reset Prompt to Default", function()
    ui.prompt:Set(DEFAULT_SYSTEM_PROMPT)
end)

-- Forward declarations: helpers below close over these locals; the test button
-- callback will resolve them at click-time once they're assigned.
local requestCompletion
local pushHistory

ui.testBtn  = g:Button("Send Test Message", function()
    pushHistory("user", "Test (you): hello team! good luck this game")
    requestCompletion(CH_TEAM)
end)

-- =============================================================================
-- Helpers
-- =============================================================================

local function safeDecode(str)
    local ok, decoded = pcall(function() return JSON:decode(str) end)
    if not ok or type(decoded) ~= "table" then return nil end
    return decoded
end

-- Diagnostic: when resp.code is 0 (client-side failure with no HTTP status),
-- the standard `code, response` print tells us nothing. Dump every field on
-- whatever the HTTP layer handed us so we can see the real failure reason
-- (timeout flag, error string, partial headers, etc.).
local function dumpResp(label, resp)
    if type(resp) ~= "table" then
        print("[AIChat]", label, "resp is not a table:", type(resp), tostring(resp))
        return
    end
    local keys = {}
    for k in pairs(resp) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    print("[AIChat]", label, "resp keys: {" .. table.concat(keys, ", ") .. "}")
    for _, k in ipairs(keys) do
        local v = resp[k]
        local tv = type(v)
        local shown
        if tv == "string" then
            shown = (#v > 300) and (v:sub(1, 300) .. "…[+" .. (#v - 300) .. " chars]") or v
        elseif tv == "table" then
            local parts = {}
            for kk, vv in pairs(v) do
                parts[#parts + 1] = tostring(kk) .. "=" .. tostring(vv):sub(1, 80)
            end
            shown = "{" .. table.concat(parts, "; ") .. "}"
        else
            shown = tostring(v)
        end
        print(string.format("[AIChat]   %s.%s (%s) = %s", label, k, tv, shown))
    end
end

local function getLocalPlayerId()
    if localPlayerIdCache then return localPlayerIdCache end
    local lp = Players and Players.GetLocal and Players.GetLocal()
    if lp and Player and Player.GetPlayerID then
        local ok, id = pcall(Player.GetPlayerID, lp)
        if ok and type(id) == "number" then
            localPlayerIdCache = id
        end
    end
    return localPlayerIdCache
end

local function trimAndTruncate(s)
    s = s:gsub("^%s+", ""):gsub("%s+$", ""):gsub("[\r\n]+", " ")
    -- Strip trailing dots/periods for authentic gamer chat feel (e.g. "ty gl." -> "ty gl")
    s = s:gsub("%s*%.+$", "")
    if #s > MAX_REPLY_CHARS then
        s = s:sub(1, MAX_REPLY_CHARS - 1) .. "…"
    end
    return s
end

local function rememberSelfReply(text)
    table.insert(recentSelfReplies, 1, text)
    while #recentSelfReplies > RECENT_REPLY_KEEP do
        table.remove(recentSelfReplies)
    end
end

local function isOwnEcho(text)
    for i = 1, #recentSelfReplies do
        if recentSelfReplies[i] == text then return true end
    end
    return false
end

local function isHeroIgnored(heroSlug)
    if not heroSlug or heroSlug == "" then return false end
    return IGNORED_HEROES[heroSlug] == true
end

-- =============================================================================
-- Game context helpers — map player_id → hero name, snapshot allies/enemies
-- =============================================================================

local function prettyHeroName(unitName)
    if type(unitName) ~= "string" or unitName == "" then return nil end
    if Engine and Engine.GetDisplayNameByUnitName then
        local ok, disp = pcall(Engine.GetDisplayNameByUnitName, unitName)
        if ok and type(disp) == "string" and disp ~= "" then return disp end
    end
    -- fallback: strip prefix and titlecase the slug
    local slug = unitName:match("npc_dota_hero_(.+)") or unitName
    return (slug:gsub("_", " "):gsub("^%l", string.upper))
end

local function heroNameOfPlayer(player)
    if not player then return nil end
    local hero = Player.GetAssignedHero and Player.GetAssignedHero(player)
    if not hero then return nil end
    local unitName = NPC.GetUnitName and NPC.GetUnitName(hero)
    return prettyHeroName(unitName)
end

local function findPlayerByID(pid)
    if type(pid) ~= "number" then return nil end
    local list = Players.GetAll and Players.GetAll() or nil
    if not list then return nil end
    for _, p in ipairs(list) do
        if Player.GetPlayerID and Player.GetPlayerID(p) == pid then
            return p
        end
    end
    return nil
end

local function getHeroSlugOfPlayer(pid)
    local p = findPlayerByID(pid)
    if not p then return nil end
    local hero = Player.GetAssignedHero and Player.GetAssignedHero(p)
    if not hero then return nil end
    local unitName = NPC.GetUnitName and NPC.GetUnitName(hero)
    if type(unitName) ~= "string" or unitName == "" then return nil end
    return unitName:match("npc_dota_hero_(.+)") or unitName
end

local function syncIgnoreListFromUI()
    IGNORED_HEROES = {}
    local enabled = ui.ignoreList:ListEnabled() or {}
    for _, heroSlug in ipairs(enabled) do
        IGNORED_HEROES[heroSlug] = true
    end
end

ui.ignoreList:SetCallback(function(this)
    syncIgnoreListFromUI()
end, false)

local function speakerLabel(pid)
    local p = findPlayerByID(pid)
    if not p then return ("Player " .. tostring(pid)) end
    local hero = heroNameOfPlayer(p) or "Unknown"
    local nameOk, nick = pcall(Player.GetName, p)
    if nameOk and type(nick) == "string" and nick ~= "" then
        return hero .. " (" .. nick .. ")"
    end
    return hero
end

local function getGameContext()
    if not Engine or not Engine.IsInGame or not Engine.IsInGame() then
        return ""
    end
    local localPlayer = Players.GetLocal and Players.GetLocal()
    local myTeam = localPlayer and Entity.GetTeamNum and Entity.GetTeamNum(localPlayer)
    local myHero = heroNameOfPlayer(localPlayer) or "(unpicked)"

    -- Detect local hero condition: Alive vs Dead, HP%, and Mana%
    local heroStatusStr = ""
    local myHeroEnt = localPlayer and Player.GetAssignedHero and Player.GetAssignedHero(localPlayer)
    if myHeroEnt then
        local isAlive = Entity and Entity.IsAlive and Entity.IsAlive(myHeroEnt)
        if isAlive == false then
            local respawnTime = (Hero and Hero.GetRespawnTime and Hero.GetRespawnTime(myHeroEnt)) or 0
            local gameTime = (GameRules and GameRules.GetGameTime and GameRules.GetGameTime()) or 0
            local remaining = math.max(0, math.floor(respawnTime - gameTime))
            heroStatusStr = string.format("Your status: DEAD (respawning in %ds).", remaining)
        else
            local hp = (Entity and Entity.GetHealth and Entity.GetHealth(myHeroEnt)) or 0
            local maxHp = (Entity and Entity.GetMaxHealth and Entity.GetMaxHealth(myHeroEnt)) or 1
            local hpPct = math.floor((hp / math.max(1, maxHp)) * 100)

            local mana = (NPC and NPC.GetMana and NPC.GetMana(myHeroEnt)) or 0
            local maxMana = (NPC and NPC.GetMaxMana and NPC.GetMaxMana(myHeroEnt)) or 1
            local manaPct = math.floor((mana / math.max(1, maxMana)) * 100)

            heroStatusStr = string.format("Your status: Alive (HP: %d%%, Mana: %d%%).", hpPct, manaPct)
        end
    end

    -- KDA, Streak, and Team Score
    local kdaStr = ""
    local teamScoreStr = ""
    local myKills, myDeaths, myAssists, myStreak = 0, 0, 0, 0
    local myTeamKills, enemyTeamKills = 0, 0

    if Player and Player.GetTeamData then
        if localPlayer then
            local okData, tData = pcall(Player.GetTeamData, localPlayer)
            if okData and type(tData) == "table" then
                myKills = tData.kills or 0
                myDeaths = tData.deaths or 0
                myAssists = tData.assists or 0
                myStreak = tData.streak or 0
            end
        end

        local allPlayers = (Players and Players.GetAll and Players.GetAll()) or {}
        for _, p in ipairs(allPlayers) do
            if myTeam and Entity and Entity.GetTeamNum and Entity.GetTeamNum(p) == myTeam then
                local okData, tData = pcall(Player.GetTeamData, p)
                if okData and type(tData) == "table" then
                    myTeamKills = myTeamKills + (tData.kills or 0)
                    enemyTeamKills = enemyTeamKills + (tData.deaths or 0)
                end
            end
        end

        local streakText = (myStreak > 2) and string.format(" (killstreak: %d)", myStreak) or ""
        kdaStr = string.format("Your KDA: %d/%d/%d%s.", myKills, myDeaths, myAssists, streakText)
        if (myTeamKills + enemyTeamKills) > 0 then
            teamScoreStr = string.format("Team score: %d vs %d.", myTeamKills, enemyTeamKills)
        end
    end

    -- Hero Inventory Items
    local itemsStr = ""
    if myHeroEnt and NPC and NPC.GetItemByIndex and Ability and Ability.GetName then
        local itemList = {}
        for i = 0, 5 do
            local it = NPC.GetItemByIndex(myHeroEnt, i)
            if it then
                local okName, name = pcall(Ability.GetName, it)
                if okName and type(name) == "string" and name ~= "" then
                    local clean = name:gsub("^item_", ""):gsub("_", " ")
                    table.insert(itemList, clean)
                end
            end
        end
        if #itemList > 0 then
            itemsStr = "Your items: " .. table.concat(itemList, ", ") .. "."
        end
    end

    local allies, enemies = {}, {}
    local list = Players.GetAll and Players.GetAll() or {}
    for _, p in ipairs(list) do
        if p ~= localPlayer then
            local heroName = heroNameOfPlayer(p)
            if heroName then
                local label = heroName
                local nameOk, nick = pcall(Player.GetName, p)
                if nameOk and type(nick) == "string" and nick ~= "" then
                    label = heroName .. " (" .. nick .. ")"
                end
                if myTeam and Entity.GetTeamNum(p) == myTeam then
                    table.insert(allies, label)
                else
                    table.insert(enemies, label)
                end
            end
        end
    end

    local parts = { "You are playing " .. myHero .. "." }
    if heroStatusStr ~= "" then table.insert(parts, heroStatusStr) end
    if kdaStr ~= "" then table.insert(parts, kdaStr) end
    if teamScoreStr ~= "" then table.insert(parts, teamScoreStr) end
    if itemsStr ~= "" then table.insert(parts, itemsStr) end
    if #allies > 0 then table.insert(parts, "Allies: " .. table.concat(allies, ", ") .. ".") end
    if #enemies > 0 then table.insert(parts, "Enemies: " .. table.concat(enemies, ", ") .. ".") end
    if GameRules and GameRules.GetGameTime then
        local t = GameRules.GetGameTime() or 0
        local start = (GameRules.GetGameStartTime and GameRules.GetGameStartTime()) or 0
        local diff = t - start
        if diff < 0 then
            local s = math.floor(math.abs(diff))
            table.insert(parts, string.format("Pre-game time: -%d:%02d.", math.floor(s / 60), s % 60))
        else
            table.insert(parts, string.format("Game time: %d:%02d.", math.floor(diff / 60), math.floor(diff % 60)))
        end
    end
    return table.concat(parts, " ")
end

-- =============================================================================
-- Chat history (rolling buffer, capped at HISTORY_HARD_CAP)
-- =============================================================================

pushHistory = function(role, content)
    chatHistory[#chatHistory + 1] = { role = role, content = content }
    while #chatHistory > HISTORY_HARD_CAP do
        table.remove(chatHistory, 1)
    end
end

local function buildMessages()
    local context = getGameContext()
    local sys = ui.prompt:Get()
    if type(sys) ~= "string" or sys == "" then
        sys = DEFAULT_SYSTEM_PROMPT
    end

    -- Append active Persona Style preset
    local personaIdx = ui.persona and ui.persona:Get() or 0
    local personaInst = PERSONA_PROMPTS[personaIdx] or PERSONA_PROMPTS[0]
    sys = sys .. "\n\n" .. personaInst

    if context ~= "" then
        sys = sys .. "\n\nGame state: " .. context
    end
    local out = { { role = "system", content = sys } }

    local n = ui.history:Get() or 30
    if n > 0 and #chatHistory > 0 then
        local startIdx = math.max(1, #chatHistory - n + 1)
        for i = startIdx, #chatHistory do
            out[#out + 1] = chatHistory[i]
        end
    end
    return out
end

-- modeIdx: 0=All, 1=Team, 2=Both
local function channelAllowed(modeIdx, ch)
    if modeIdx == 2 then return true end
    if modeIdx == 0 then return ch == CH_ALL end
    if modeIdx == 1 then return ch == CH_TEAM end
    return false
end

local function cooldownReady(pid)
    local last = lastReplyTime[pid]
    if not last then return true end
    return (GameRules.GetGameTime() - last) >= ui.cooldown:Get()
end

-- =============================================================================
-- HTTP request
-- =============================================================================
-- HTTP.Request(method, url, opts, callback) per UCZone API v2.0:
-- opts.headers (table), opts.cookies (string), opts.data (string body), opts.timeout (number).
-- Body is `data`, NOT `body`. opts.timeout is in MILLISECONDS (default ~10000),
-- which is too short for slow LLM proxies — that triggered the
-- "Operation timed out after 10002 milliseconds" failures.
local HTTP_TIMEOUT_MS = 30000

requestCompletion = function(replyChannel)
    if isRequestInProgress then
        print("[AIChat] request already in progress, skipping")
        return
    end

    local apiKey = ui.apiKey:Get()
    if apiKey == "" and ui.preset:Get() == 0 then
        if not warnedNoKey then
            print("[AIChat] API Key is empty — set it in the menu.")
            warnedNoKey = true
        end
        return
    end

    local body = JSON:encode({
        model       = ui.model:Get(),
        messages    = buildMessages(),
        max_tokens  = MAX_TOKENS,
        temperature = TEMPERATURE,
        stream      = false,
    })

    local headers = {
        ["Content-Type"]  = "application/json",
    }
    if apiKey ~= "" then
        headers["Authorization"] = "Bearer " .. apiKey
    end

    local options = {
        headers = headers,
        data = body,
        timeout = HTTP_TIMEOUT_MS,
    }

    local url = ui.baseUrl:Get() .. "/chat/completions"

    isRequestInProgress = true

    HTTP.Request("POST", url, options, function(resp)
        isRequestInProgress = false

        local code = resp and resp.code
        if type(code) == "string" then code = tonumber(code) or 0 end
        if not resp or code ~= 200 or not resp.response then
            print("[AIChat] HTTP error to", url,
                "— code=", resp and resp.code or "nil",
                "responseLen=", resp and resp.response and #resp.response or 0)
            dumpResp("chat", resp)
            return
        end

        if not ui.enabled:Get() then return end -- toggled off mid-flight

        local decoded = safeDecode(resp.response)
        if not decoded then
            print("[AIChat] decode failed. Response: " .. tostring(resp.response))
            return
        end

        local choice = decoded.choices and decoded.choices[1]
        local msg    = choice and choice.message and choice.message.content
        if type(msg) ~= "string" then
            print("[AIChat] no content in response")
            return
        end

        msg = trimAndTruncate(msg)
        if msg == "" then return end

        rememberSelfReply(msg)
        pushHistory("assistant", msg)
        print("[AIChat] reply queued ->", replyChannel, ":", msg)

        local now = os.clock()
        local typingDelay = math.random(12, 25) / 10
        table.insert(outboxQueue, {
            channel = replyChannel,
            text    = msg,
            sendAt  = now + typingDelay,
            isLocal = false,
        })
    end)
end

-- =============================================================================
-- Net message handler — typed chat arrives as a server->client net message.
-- The `data` table has: data.message_id (number), data.msg_object (lightuserdata).
-- We decode candidate chat protobuf types until one yields a `message_text` field.
-- =============================================================================

-- decodeToJSONfromObject takes ONLY the lightuserdata — protobuf type is
-- auto-detected from the object. No type name needed.
local function tryDecode(msgObject)
    if not protobuf or not protobuf.decodeToJSONfromObject then return nil end
    local ok, json = pcall(protobuf.decodeToJSONfromObject, msgObject)
    if not ok or type(json) ~= "string" or json == "" then return nil end
    if json:sub(1, 1) ~= "{" then return nil end
    local okp, parsed = pcall(function() return JSON:decode(json) end)
    if not okp or type(parsed) ~= "table" then return nil end
    return parsed
end

-- Numbers come back as strings from the protobuf->JSON path; convert defensively.
local function asNum(v)
    if type(v) == "number" then return v end
    if type(v) == "string" then return tonumber(v) end
    return nil
end

-- Locked from observed payload at id 612: {message_text, source_player_id, channel_type}.
-- Channel 12 = team chat (DOTAChannelType_Team in this build), other values = all/lobby/etc.
local INCOMING_CHAT_ID = 612

local function onNetMessage(data)
    if type(data) ~= "table" then return end
    if data.message_id ~= INCOMING_CHAT_ID then return end
    if not ui.enabled:Get() then return end

    local payload = tryDecode(data.msg_object)
    if not payload then return end

    local text     = payload.message_text or payload.text
    local speaker  = asNum(payload.source_player_id or payload.account_id
                        or payload.player_id or payload.playerid)
    local channel  = asNum(payload.channel_type)
    if type(text) ~= "string" or text == "" then return end
    if type(speaker) ~= "number" or speaker < 0 then return end

    -- Ignore console commands and chat shortcuts (e.g. -ping, !pause, /laugh)
    if text:match("^%s*[%-%!%/]") then return end

    local localId = getLocalPlayerId()
    if not localId then
        print("[AIChat] drop: no local player id"); return
    end

    -- Always record into history with hero context, even if we won't reply.
    -- That way the AI sees the full conversation when generating later replies.
    local label = (speaker == localId) and "You" or speakerLabel(speaker)
    pushHistory("user", label .. ": " .. text)

    if speaker == localId then
        if not ui.replySelf:Get() then return end
        if isOwnEcho(text) then
            print("[AIChat] drop: own AI echo"); return
        end
    end

    -- channel_type 12 = team chat, anything else treat as all chat
    local incoming = (channel == 12) and CH_TEAM or CH_ALL

    if not channelAllowed(ui.channel:Get(), incoming) then
        print("[AIChat] drop: channel-mode blocks", incoming); return
    end
    if not cooldownReady(speaker) then
        print("[AIChat] drop: cooldown for", speaker); return
    end

    -- Check if hero is in ignore list
    local heroSlug = getHeroSlugOfPlayer(speaker)
    if heroSlug and isHeroIgnored(heroSlug) then
        print("[AIChat] drop: hero ignored", heroSlug); return
    end

    lastReplyTime[speaker] = GameRules.GetGameTime()
    print("[AIChat] heard:", incoming, "from", label, "text=", text)
    requestCompletion(incoming)
end

-- =============================================================================
-- Enemy activity warnings (Roshan / smoke / jungle)
-- Position-based checks run on a timer; smoke uses a modifier probe.
-- Warnings are plain team/all chat sends with per-enemy per-type cooldowns.
-- =============================================================================

local warnGroup = tab:Create("Main"):Create("Enemy Warnings")
ui.warnEnabled  = warnGroup:Switch("Enable Warnings",           false, "\u{f071}")
ui.warnRoshan   = warnGroup:Switch("Warn: Enemy at Roshan (Unsafe)", true,  "\u{f6d1}")
ui.warnSmoke    = warnGroup:Switch("Warn: Enemy Smoked",        true,  "\u{f72e}")
ui.warnJungle   = warnGroup:Switch("Warn: Enemy in Jungle",     true,  "\u{f1bb}")
ui.warnCooldown = warnGroup:Slider("Warning Cooldown (s)", 10, 120, 30, "%d s")
ui.warnChannel  = warnGroup:Combo ("Warning Channel", {"Team chat", "Local only (Chat box)", "Console only"}, 0)
ui.warnDebug    = warnGroup:Switch("Debug: Log Modifier Events", false, "\u{f188}")

local JUNGLE_CAMP_POS = {
    Vector(-3150,  -800, 0), Vector(-4600,   800, 0),
    Vector(-2000,  2000, 0), Vector(-2000, -2000, 0),
    Vector(-3800,     0, 0),
    Vector(-5200,  1800, 0), Vector(-5200, -1800, 0),
    Vector( 3150,   800, 0), Vector( 4600,  -800, 0),
    Vector( 2000, -2000, 0), Vector( 2000,  2000, 0),
    Vector( 3800,     0, 0),
    Vector( 5200, -1800, 0), Vector( 5200,  1800, 0),
}
local JUNGLE_RADIUS = 900

local warnCooldowns = {} -- [pid] = { roshan=t, smoke=t, jungle=t }

local function warnReady(pid, kind)
    local entry = warnCooldowns[pid]
    if not entry or not entry[kind] then return true end
    return (GameRules.GetGameTime() - entry[kind]) >= ui.warnCooldown:Get()
end

local function markWarned(pid, kind)
    warnCooldowns[pid] = warnCooldowns[pid] or {}
    warnCooldowns[pid][kind] = GameRules.GetGameTime()
end

local function posNearAny(pos, list, radius)
    for _, p in ipairs(list) do
        if pos:Distance(p) <= radius then return true end
    end
    return false
end

local function heroPID(h)
    if Hero and Hero.GetPlayerID then
        local ok, pid = pcall(Hero.GetPlayerID, h)
        if ok and type(pid) == "number" then return pid end
    end
    return nil
end

local function myTeamNum()
    local lp = Players and Players.GetLocal and Players.GetLocal()
    if not lp or not Entity or not Entity.GetTeamNum then return nil end
    local ok, t = pcall(Entity.GetTeamNum, lp)
    if ok and type(t) == "number" then return t end
    return nil
end

-- Small, focused system prompt for warnings — deliberately separate from the
-- main persona (DEFAULT_SYSTEM_PROMPT) so we don't inherit its rules.
local WARN_SYSTEM_PROMPT = [[You turn a Dota 2 event into ONE short team-chat notification.
Rules:
- one sentence, under 10 words, lowercase, no emojis, no hashtags, no quotes
- PURE NOTIFICATION: never give advice, suggestions, instructions, or call-to-actions. Forbidden: "care", "rotate", "back", "push", "watch out", "stay alert", "heads up", "gotta", "we need to", "lets", "lads", "guys", "now", etc.
- NEVER invent facts that aren't in the event. Do NOT mention lanes, map locations (mid, top, bot, river, rune, pit), targets, intentions, or timings unless the event text already contains them.
- grounded tone — NO jokes, NO sarcasm, NO metaphors, NO similes ("like a X"), NO pop-culture references
- vary structure and word choice so you don't repeat the "previous calls" below, but keep the plain tone
- output only the line, nothing else]]

-- Purely structural nudges — they rearrange the event, they do NOT add content
-- or tone. No location-based hints (AI would invent them).
local WARN_STYLE_HINTS = {
    "lead with the hero name",
    "lead with the action verb",
    "use an ss-style abbreviation",
    "one compact noun-phrase only, no verb",
    "state it in subject-verb-object order",
    "use a synonym for the action verb",
    "state it in present continuous tense",
}

local recentWarnTexts = {}
local RECENT_WARN_KEEP = 8

local function pushRecentWarn(text)
    table.insert(recentWarnTexts, 1, text)
    while #recentWarnTexts > RECENT_WARN_KEEP do
        table.remove(recentWarnTexts)
    end
end

-- Sends a warning by asking the configured model to phrase the event as a
-- one-liner. Falls back to the literal event string if the request fails,
-- key is missing, or channel is set to console-only.
local function sendWarning(eventDesc, pos)
    if pos then
        print(string.format("[AIChat] event: %s @ (%.0f, %.0f, %.0f)",
            eventDesc, pos.x or 0, pos.y or 0, pos.z or 0))
    else
        print("[AIChat] event:", eventDesc)
    end

    local mode = ui.warnChannel:Get()
    local isLocal = (mode == 1)
    local isConsoleOnly = (mode == 2)

    local function rawSend(text)
        print("[AIChat] warn:", text)
        pushRecentWarn(text)
        rememberSelfReply(text) -- so our own responder doesn't echo-reply to it

        if isConsoleOnly then return end

        if isLocal then
            if Chat and Chat.Print then
                Chat.Print(CH_TEAM, "[AIChat Warn] " .. text)
            end
        else
            local now = os.clock()
            table.insert(outboxQueue, {
                channel = CH_TEAM,
                text    = text,
                sendAt  = now + 0.3,
                isLocal = false,
            })
        end
    end

    if isConsoleOnly then
        return
    end

    local apiKey = ui.apiKey:Get()
    if apiKey == "" and ui.preset:Get() == 0 then rawSend(eventDesc); return end

    local style = WARN_STYLE_HINTS[math.random(#WARN_STYLE_HINTS)]
    local userLines = { "Event: " .. eventDesc, "Style this time: " .. style }
    if #recentWarnTexts > 0 then
        table.insert(userLines, "")
        table.insert(userLines, "Previous calls (DO NOT REPEAT, avoid similar phrasing):")
        for _, t in ipairs(recentWarnTexts) do
            table.insert(userLines, "- " .. t)
        end
    end
    local userContent = table.concat(userLines, "\n")

    local body = JSON:encode({
        model       = ui.model:Get(),
        messages    = {
            { role = "system", content = WARN_SYSTEM_PROMPT },
            { role = "user",   content = userContent },
        },
        max_tokens  = 40,
        temperature = 0.9,
        stream      = false,
    })

    local headers = {
        ["Content-Type"]  = "application/json",
    }
    if apiKey ~= "" then
        headers["Authorization"] = "Bearer " .. apiKey
    end

    local options = {
        headers = headers,
        data = body,
        timeout = HTTP_TIMEOUT_MS,
    }

    HTTP.Request("POST", ui.baseUrl:Get() .. "/chat/completions", options, function(resp)
        if not ui.warnEnabled:Get() then return end -- toggled off mid-flight
        local code = resp and resp.code
        if type(code) == "string" then code = tonumber(code) or 0 end
        if not resp or code ~= 200 or not resp.response then
            print("[AIChat] warn HTTP error — code=",
                resp and resp.code or "nil",
                "responseLen=", resp and resp.response and #resp.response or 0)
            dumpResp("warn", resp)
            rawSend(eventDesc); return
        end
        local decoded = safeDecode(resp.response)
        if not decoded then
            print("[AIChat] warn decode failed. Response: " .. tostring(resp.response))
            rawSend(eventDesc); return
        end
        local choice  = decoded.choices and decoded.choices[1]
        local msg     = choice and choice.message and choice.message.content
        if type(msg) ~= "string" then rawSend(eventDesc); return end
        msg = trimAndTruncate(msg)
        if msg == "" then rawSend(eventDesc); return end
        rawSend(msg)
    end)
end

local function isIllusion(h)
    if NPC and NPC.IsIllusion then
        local ok, v = pcall(NPC.IsIllusion, h)
        if ok then return v == true end
    end
    return false
end

-- "Out of vision" means our team can't see this unit (NPC.IsVisible returns
-- false). Cheat knows the unit regardless; this check gates jungle warnings
-- so we don't spam when teammates already have vision.
local function outOfVision(h)
    if not NPC or not NPC.IsVisible then return false end
    local ok, v = pcall(NPC.IsVisible, h)
    if not ok then return false end
    return v == false
end

-- Smoke is detected by OnParticleCreate (primary — replicates to all clients
-- regardless of vision) and OnModifierCreate (secondary — only fires when the
-- smoked hero is in team vision). Jungle is a position scan gated by out-of-vision.
local function checkEnemyActivity()
    if not ui.warnEnabled:Get() then return end
    if not Engine or not Engine.IsInGame or not Engine.IsInGame() then return end
    local team = myTeamNum()
    if not team then return end
    local list = Heroes and Heroes.GetAll and Heroes.GetAll() or {}

    for _, h in ipairs(list) do
        if h and Entity.IsAlive(h)
           and Entity.GetTeamNum(h) ~= team
           and not isIllusion(h) then
            local pid = heroPID(h)
            if pid and ui.warnJungle:Get() and warnReady(pid, "jungle")
               and outOfVision(h) then
                local pos = Entity.GetAbsOrigin(h)
                if posNearAny(pos, JUNGLE_CAMP_POS, JUNGLE_RADIUS) then
                    markWarned(pid, "jungle")
                    local name = prettyHeroName(NPC.GetUnitName(h)) or "enemy"
                    sendWarning(name .. " is farming our jungle", pos)
                end
            end
        end
    end
end

local lastWarnScan = 0
local lastIgnoreListUpdate = 0
local wasInGame = false

local function processOutboxQueue()
    if #outboxQueue == 0 then return end
    local now = os.clock()
    if (now - lastChatSentTime) < MIN_CHAT_INTERVAL then return end

    local item = outboxQueue[1]
    if now >= item.sendAt then
        table.remove(outboxQueue, 1)
        lastChatSentTime = now

        local inGame = Engine and Engine.IsInGame and Engine.IsInGame()
        if item.isLocal then
            print("[AIChat] local print ->", item.text)
            if Chat and Chat.Print then
                Chat.Print(item.channel or CH_TEAM, item.text)
            end
        else
            print("[AIChat] sent ->", item.channel, ":", item.text)
            if not inGame then
                print("[AIChat] (note: Chat.Say called while not in-game; in-game chat requires an active match)")
            end
            if Chat and Chat.Say then
                Chat.Say(item.channel or CH_TEAM, item.text)
            end
        end
    end
end

local function onUpdate()
    pcall(processOutboxQueue)

    local inGame = GameRules and GameRules.GetGameTime and Engine and Engine.IsInGame and Engine.IsInGame()

    -- Update ignore list on game state change or periodically
    if inGame ~= wasInGame then
        wasInGame = inGame
        pcall(updateIgnoreListHeroes)
    elseif inGame and GameRules.GetGameTime then
        local now = GameRules.GetGameTime() or 0
        if (now - lastIgnoreListUpdate) >= 3 then
            lastIgnoreListUpdate = now
            pcall(updateIgnoreListHeroes)
        end
    end

    if not inGame then return end
    local now = GameRules.GetGameTime() or 0
    if not ui.warnEnabled:Get() then return end
    if (now - lastWarnScan) < 0.5 then return end
    lastWarnScan = now
    pcall(checkEnemyActivity)
end

-- Global dedup between particle path and the later modifier-create path.
-- Both can fire for the same smoke (particle on use, modifier when the hero
-- re-enters vision); this keeps the warning to one.
local lastSmokeWarnAt = 0
local SMOKE_DEDUPE_WINDOW = 8

local function smokeRecentlyWarned()
    if lastSmokeWarnAt == 0 then return false end
    local now = (GameRules and GameRules.GetGameTime and GameRules.GetGameTime()) or 0
    return (now - lastSmokeWarnAt) < SMOKE_DEDUPE_WINDOW
end

local function markSmokeWarned()
    lastSmokeWarnAt = (GameRules and GameRules.GetGameTime and GameRules.GetGameTime()) or 0
end

-- Fires the instant modifier_smoke_of_deceit is applied to an enemy hero —
-- the same signal that drives the built-in "Enemy has used Smoke of Deceit"
-- console notification. Exact-match the name to skip _secondary_application_cooldown.
local function onModifierCreate(entity, modifier)
    if not ui.warnEnabled:Get() then return end
    if not entity or not modifier then return end
    local okName, modName = pcall(Modifier.GetName, modifier)
    if not okName or type(modName) ~= "string" then return end

    if ui.warnDebug:Get() then
        local unitName = (NPC and NPC.GetUnitName and NPC.GetUnitName(entity)) or "?"
        print("[AIChat] modcreate:", unitName, modName)
    end

    if not ui.warnSmoke:Get() then return end
    if modName ~= "modifier_smoke_of_deceit" then return end
    if smokeRecentlyWarned() then return end
    local team = myTeamNum()
    if not team then return end
    local okTeam, entTeam = pcall(Entity.GetTeamNum, entity)
    if not okTeam or entTeam == team then return end
    if not Entity.IsHero or not Entity.IsHero(entity) then return end
    if isIllusion(entity) then return end
    local pid = heroPID(entity)
    if not pid or not warnReady(pid, "smoke") then return end
    markWarned(pid, "smoke")
    markSmokeWarned()
    local name = prettyHeroName(NPC.GetUnitName(entity)) or "enemy"
    local pos = Entity.GetAbsOrigin and Entity.GetAbsOrigin(entity) or nil
    sendWarning(name .. " used smoke of deceit", pos)
end

-- Primary smoke detection: the smoke_of_deceit particle replicates to every
-- client regardless of vision (same signal that drives the in-game "Enemy has
-- used Smoke of Deceit" console message). Works in fog where OnModifierCreate
-- can't reach — but in that case data.entityForModifiers is nil, so we warn
-- generically rather than bailing.
local function onParticleCreate(data)
    if not ui.warnEnabled:Get() or not ui.warnSmoke:Get() then return end
    if type(data) ~= "table" then return end

    local pname = data.fullName or data.name
    if type(pname) ~= "string" then return end

    if ui.warnDebug:Get() and pname:find("smoke", 1, true) then
        print("[AIChat] particle:", pname)
    end

    if not pname:find("smoke_of_deceit", 1, true) then return end
    if smokeRecentlyWarned() then return end

    local team = myTeamNum()
    if not team then return end

    local entity = data.entityForModifiers or data.entity
    local name, pos, pid = "enemy", nil, nil

    -- If we can identify the entity, filter out our own team and enrich the label.
    if entity then
        local okTeam, entTeam = pcall(Entity.GetTeamNum, entity)
        if okTeam and entTeam == team then return end -- our own smoke
        if Entity.IsHero and Entity.IsHero(entity) and not isIllusion(entity) then
            pid = heroPID(entity)
            local okName, uname = pcall(NPC.GetUnitName, entity)
            if okName then name = prettyHeroName(uname) or "enemy" end
            local okPos, p = pcall(Entity.GetAbsOrigin, entity)
            if okPos then pos = p end
        end
    end

    -- Per-hero cooldown when known, shared "anon" bucket otherwise.
    local cdKey = pid or "anon"
    if not warnReady(cdKey, "smoke") then return end
    markWarned(cdKey, "smoke")
    markSmokeWarned()
    sendWarning(name .. " used smoke of deceit", pos)
end

-- Only warn when Roshan actually takes damage, not when an enemy is merely nearby.
-- Fires regardless of whether the attacker is in team vision or fog.
local function onEntityHurt(data)
    if not ui.warnEnabled:Get() or not ui.warnRoshan:Get() then return end
    if type(data) ~= "table" then return end
    local target, source = data.target, data.source
    if not target or not source then return end
    if not NPC.IsRoshan or not NPC.IsRoshan(target) then return end
    if not Entity.IsHero or not Entity.IsHero(source) then return end
    local team = myTeamNum()
    if not team then return end
    local okTeam, srcTeam = pcall(Entity.GetTeamNum, source)
    if not okTeam or srcTeam == team then return end
    if isIllusion(source) then return end
    local pid = heroPID(source)
    if not pid or not warnReady(pid, "roshan") then return end
    markWarned(pid, "roshan")
    local name = prettyHeroName(NPC.GetUnitName(source)) or "enemy"
    local pos = Entity.GetAbsOrigin and Entity.GetAbsOrigin(source) or nil
    sendWarning(name .. " is attacking roshan", pos)
end

-- =============================================================================
-- Game Lifecycle
-- =============================================================================

local function onGameEnd()
    localPlayerIdCache  = nil
    chatHistory         = {}
    lastReplyTime       = {}
    warnCooldowns       = {}
    recentSelfReplies   = {}
    recentWarnTexts     = {}
    lastMatchHeroes     = {}
    outboxQueue         = {}
    isRequestInProgress = false
    lastChatSentTime    = 0
    print("[AIChat] Game ended — state, cache, and history cleared.")
end

-- =============================================================================
-- Returned callbacks
-- =============================================================================

return {
    OnPostReceivedNetMessage = onNetMessage,
    OnUpdate                 = onUpdate,
    OnUpdateEx               = onUpdate,
    OnModifierCreate         = onModifierCreate,
    OnParticleCreate         = onParticleCreate,
    OnEntityHurt             = onEntityHurt,
    OnGameEnd                = onGameEnd,
}
