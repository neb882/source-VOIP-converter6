/* =========================================================================
 * TF2 Voice Emulator — constants.js
 *
 * Data-only module. Exposes globals for other scripts to consume:
 *   TF2_DATA           — names, weapons, chat lines, errors, system, achievements
 *   PRESETS            — quick processing presets (modern / legacy / spam ...)
 *   CODEC_PROFILES     — real libopus configurations for each voice codec
 *   VOICE_ENGINE       — receiver-side voice path (auto-gain, mixer, output)
 *   DSP_PRESETS        — Source engine dsp_room presets 0-29, transcribed from
 *                        Valve's scripts/dsp_presets.txt (see comments)
 *   LISTENER_POSITIONS — map-location → dsp_room mappings
 *   FCVAR              — Source cvar flag bits
 *
 * References:
 *   - Valve dsp_presets.txt (via the Facepunch garrysmod mirror) — the RVA/
 *     DFR/DLY/AMP/MDY processor parameters below are copied verbatim.
 *   - zhenyangli.me "Reversing Steam Voice Codec" — Steam voice is Opus at
 *     24 kHz mono.
 *   - tests/REFERENCE_2026.md — paired loopback measurements behind the
 *     Steam profile and VOICE_ENGINE values.
 * ========================================================================= */

const TF2_DATA = {
  playerNames: [
    "Nebula", "Floppa", "Snail7", "WarHen", "Specimen04",
    "KrispyTheNugget", "Duck_Baesos", "Mountain Oil Enjoyer",
    "poopedmypants777", "megarayo", "SixoMan", "Skye",
    "rocket jumping loser", "alkiosavainash", "dudlee",
    "mmich456", "NEVER SOON", "snappy", "hi jo", "Wojak",
    "Sempii", "Shotgun", "dex", "mothdamn", "starleo303",
    "blackshadow", "Friday Funkin'", "GibusMann", "jose.gonzales.2007",
    "Engineer Gaming", "Xx_DarkSlayer_xX", "Pootis Spencer", "Dr. Sex",
    "scout main", "TF2 Player", "unnamed", "Valve", "Gaben",
    "SpyCrab", "Hoovy", "Rick May", "OMEGATRONIC", "DoesHotter",
    "festive hitman", "Samsung Smart Fridge", "Tax Evasion", "CEO of Racism",
    "Bread", "Soup", "Obama Gaming", "shrek", "Heavy Weapons Guy",
    "medic gf", "The Observer", "Spy", "Sniper", "Demoman",
    "pyro shark", "trolldier", "Soundsmith", "LazyPurple",
    "Uncle Dane", "Big Joey", "SolarLight", "Vorobey",
    "Zesty Jesus", "Elmaxo", "Wutville Enjoyer", "2fort 24/7",
    "trade.tf user", "scrap.tf bot 04", "Market Plandener", "Force-A-Nature",
    "Lime Scunt", "Generic Soldier Main", "crocket magnet", "w+m1",
    "f2p sniper", "aimbot?", "cheater", "vac banned", "kicked",
    "disconnected", "connecting...", "error", "missing texture",
    "Purple Checkerboard", "A Pose Scout", "Civilian Heavy", "Binoculus",
    "Potassium Bonnet", "Burning Team Captain", "Golden Pan Owner", "Saxxy Winner",
    "Developer", "Admin", "Moderator", "Owner", "Host",
    "Guest", "Player", "Human", "Bot", "AI",
    "NPC", "Enemy", "Ally", "Teammate", "Friend",
    "Rival", "Nemesis", "Target", "Victim", "Killer",
    "Pablo.gonzales.2005", "Killer_69", "PRO_GAMER_HD", "mom_said_its_my_turn",
    "xX_Sephiroth_Xx", "Kirito", "Naruto123", "sans gaming",
    "dispenser_goes_here", "nope.avi", "mentlegen", "spy_among_us"
  ],
  weapons: [
    "tf_projectile_rocket", "sniperrifle", "scattergun", "minigun",
    "iron_bomber", "stickybomb_launcher", "targe_charge", "nessieclub",
    "market_gardener", "bazaar_bargain", "phlogistinator", "flamethrower",
    "scorch_shot", "tomislav", "knife", "eternal_reward", "ambassador",
    "obj_sentrygun3", "world", "trigger_hurt", "smg", "fireaxe",
    "airstrike", "big_earner", "force_a_nature", "loch_n_load",
    "revolver", "pistol", "bottle", "bat", "shovel", "wrench", "bonesaw",
    "fists", "shotgun_soldier", "shotgun_pyro", "shotgun_hwg",
    "backburner", "degreaser", "reserve_shooter", "blackbox",
    "rocketlauncher_directhit", "cow_mangler", "beggars_bazooka",
    "disciplinary_action", "escape_plan", "equalizer", "pain_train",
    "ullapool_caber", "loose_cannon", "scottish_resistance",
    "claidheamh_mor", "persian_persuader", "fryingpan", "ham_shank",
    "natascha", "brass_beast", "huo_long_heater", "family_business",
    "gloves_running_urgently", "fists_of_steel", "frontier_justice",
    "robot_arm", "jag", "southern_hospitality", "rescue_ranger",
    "blutsauger", "ubersaw", "vita_saw", "amputator", "solemn_vow",
    "sydney_sleeper", "machina", "hitmans_heatmaker", "classic",
    "bushwacka", "shahanshah", "tribalmans_shiv", "club", "diamondback",
    "letranger", "kunai", "sharp_dresser", "spy_cicle", "taunt_scout",
    "taunt_heavy", "taunt_pyro", "taunt_spy", "obj_sentrygun",
    "obj_sentrygun2", "obj_minisentry", "tf_projectile_pipe",
    "tf_projectile_arrow", "tf_projectile_jar", "deflect_rocket",
    "deflect_promode", "sawmill_blade", "train", "lava",
    "golden_frying_pan", "saxxy", "prinny_machete", "batsaber", "capper"
  ],
  chat: [
    "woof", "meow", "no we need more spies", "nice hit",
    "scorch shot and phlog is a sin", "so mean", "Hello",
    "can we get a medic my fellow men?", "ns", "lag",
    "spy behind", "F1", "F2", "gg", "ez", "diff", "sellout",
    "kick bot", "random crits are fair and balanced", "MEDIC!",
    "w+m1 noob", "spy has dead ringer", "f1 cheater", "selling keys",
    "thanks pally", "engineer gaming", "crocket", "pootis",
    "why do we have 5 snipers?", "move that gear up", "team?",
    "nice facestab", "uber popped", "spy is gun spy", "nt",
    "scunt", "medic gf", "buying hats", "demoknight tf2",
    "spy checking", "f2 he's clean", "mge me", "tryhard",
    "heavy update when", "pyro airblast pls", "sentry down",
    "dispenser here", "thanks doc", "nice unusual", "get rekt",
    "friendly hoovy dont kill", "cap the point", "push cart",
    "hightower no cap", "market gardener", "nice ping", "cl_interp abuser",
    "pocket medic", "pop it don't drop it", "pybro", "homewrecker",
    "sentry nest ahead", "stickies on point", "intel dropped",
    "we have no engineer", "medic why", "spy is disguised as heavy",
    "lime scout", "auto balance sucks", "scramble teams", "don't kill friendlies",
    "taunt kill", "killbind", "trade server?", "selling 2 ref",
    "nice cosmetics", "bot is aimbotting", "vote kick", "sorry lag",
    "bodyshot", "nice hacks", "teleporter entrance here", "uber ready",
    "battle medic", "stop dying", "gh", "gr", "ty",
    "I swear if I die to one more random crit I am uninstalling this game",
    "can one of the 4 snipers please switch to medic or power class thanks",
    "Selling Unusual Burning Flames Team Captain 2000 keys pure only no dupes",
    "dude stop taking the health pack when you have 124 hp and I'm burning to death",
    "why is nobody pushing the cart it literally moves backward when you don't touch it",
    "selling strange killstreak festive rocket launcher for 5 keys send trade offer",
    "kick the bot in the name of our lord and savior gaben please F1",
    "medic why did you pop uber on the sniper instead of the heavy?",
    "can someone please help me with this spy sapping my sentry over and over",
    "imagine using the phlog and scorch shot and thinking you have actual skill",
    "enemy team has 3 medics and we have 4 spies and a demoknight",
    "guys the spy is disguised as me don't let him backstab you",
    "Buying all backpacks quicksell prices only paying in refined metal add me",
    "sorry guys my ping just spiked to 9000 I can't move",
    "that hitreg was absolutely broken I was clearly behind the wall",
    "please stop capping on hightower we are just trying to deathmatch",
    "looking for a pocket medic for competitive 6s pm me for discord",
    "I have full uber charge stop running away from me you idiot",
    "how did that backstab count? he was looking right at me valve pls fix",
    "everyone go left side through the tunnel they have a sentry on the right",
    "press F1 to kick the cheater he is spinning in spawn",
    "thank you for the heals medic you are the only reason we are winning",
    "demo can you please destroy the nest upstairs before we push in?",
    "bind w kill", "quit smoking", "disconnecting in 3...", "lol", "lmao",
    "cringe", "based", "ratio", "L", "W", "rip bozo",
    "skill issue", "gaming chair diff", "touch grass"
  ],
  errors: [
    "SetupBones: invalid bone array size (2 - needs 3)",
    "No such variable \"$fogstart\" for material \"maps/ctf_2fort/water/water_2fort_-528_-1520_-128\"",
    "No such variable \"$bloomamount\" for material \"dev/blurfiltery_nohdr\"",
    "Error! Variable \"$yellow\" is multiply defined in material \"models/workshop_partner/player/items/all_class/jackbadge/jackbadge_limited\"!",
    "No such variable \"$basetexture\" for material \"effects/rockettrailsmoke\"",
    "KeyValues Error: RecursiveLoadFromBuffer: got } in key in file materials/models/props_foliage/grass_02.vmt",
    "Model models/props_gameplay/security_fence_section01.mdl not found and models/error.mdl couldn't be loaded",
    "MP3 initialized with no sound cache",
    "Requesting texture value from var \"$dummyvar\" which is not a texture value (material: skybox/sky_dustbowl_01rt)",
    "DataTable warning: player: Could not find table \"DT_TFPlayerScoringDataExclusive\"",
    "Failed to load sound \"vo\\scout_painsharp01.wav\", file probably missing from disk/repository",
    "Error: Material \"models/player/scout/scout_head\" : proxy \"AnimatedTexture\" unable to initialize!",
    "C_TFPlayer::Reset: restarting partial cycle",
    "Attempted to precache unknown particle system \"explosion_trail\"",
    "SOLID_VPHYSICS static prop with no vphysics model! (models/props_combine/combine_fence01b.mdl)",
    "CMaterial::PrecacheVars: error loading vmt file for models/props_gameplay/haybale",
    "unhandled sticker option \"sticker_path\"",
    "Error vertex file for 'models/player/scout.mdl' checksum -1234567890 should be 1234567890",
    "DispatchAsyncEvent: event id 9832 has no handler.",
    "SV_StartSound: weapons\\rocket_shoot.wav not precached (0)",
    "Bad pstudiohdr in GetSequenceLinearMotion()!",
    "C_BaseEntity::SaveData: missing field 'm_hOwnerEntity'",
    "Particles: StartCapEndCap: particle system 'flamethrower_crit_red' not found",
    "Scene 'scenes/player/scout/low/taunt01.vcd' missing!"
  ],
  system: [
    "Lobby updated",
    "Redownloading all lightmaps",
    "Compact freed 200704 bytes",
    "Connecting to 192.168.1.10:27015...",
    "Connected to 192.168.1.10:27015",
    "Network: IP 10.0.0.5, mode MP, dedicated No, ports 27015 SV / 27005 CL",
    "VAC secure mode is activated.",
    "Parsed 354 particle systems",
    "Initializing renderer...",
    "Host_WriteConfiguration: Wrote cfg/config.cfg",
    "Using specific color correction file: materials/correction/cc_2fort.raw",
    "Server has disabled lobby reservations",
    "Disconnect: Client disconnect.",
    "Processing rates updates...",
    "Changing map to pl_upward",
    "Precomputing lighting ... Done",
    "Dropped Player from server (Disconnect by user.)",
    "Game supporting: multiplayer",
    "Writing configuration to \"config.cfg\"",
    "Client \"User\" connected (127.0.0.1:27005)."
  ],
  achievements: [
    "Head of the Class", "Hard to Kill", "Master of Disguise",
    "Grey Matter", "Riftwalker", "Flamethrower", "Sentry Gunner",
    "Point Clicker", "Backstabber", "Double Donk", "Flag Bearer",
    "World Traveler", "Prime Cuts", "First Blood", "Nemesis",
    "Hardcore", "Impossible!", "Gotta Cap 'Em All", "Pyromancer",
    "Caber Tosser", "Sticky Jumper", "Rocket Man", "Scout's Honor"
  ],
  items: [
    "Mann Co. Supply Crate", "Refined Metal", "Reclaimed Metal", "Scrap Metal",
    "Name Tag", "Description Tag", "Decal Tool", "Dueling Mini-Game",
    "Giftapult", "Backpack Expander", "Tour of Duty Ticket",
    "Mann Co. Store Package", "Random Craft Hat", "Secret Saxton",
    "Pile of Robo-Key Gifts", "Noise Maker - Winter Holiday",
    "Spellbook Page", "Haunted Metal Scrap", "Unusual Parsley",
    "Golden Frying Pan (Rare!)", "Australium Rocket Launcher"
  ]
};

/* -------------------------------------------------------------------------
 * Quick processing presets (keyed into `exec preset_<name>`)
 * `codec` matches a key in CODEC_PROFILES, `position` matches LISTENER_POSITIONS.
 * hp 0 / lp 20000 leave the optional sender filters off: the measured TF2
 * path has no capture EQ beyond Opus's own voice high-pass and band edge.
 * gain > 1 overdrives the sender's int16 capture before encoding.
 * ------------------------------------------------------------------------- */
const PRESETS = {
  // Measured baseline: Steam voice as recorded with voice_loopback in 2026.
  modern:  { codec: 'steam',   position: 'open',   hp: 0, lp: 20000, voice_scale: 1.0, gain: 1.0, loss: 0  },
  // CELT-era codec stand-in with the same receiver path.
  legacy:  { codec: 'celt_22', position: 'open',   hp: 0, lp: 20000, voice_scale: 1.0, gain: 1.0, loss: 0  },
  // Loud mic spam: overdriven capture, in a tunnel for extra reverb drama.
  spam:    { codec: 'steam',   position: 'tunnel', hp: 0, lp: 20000, voice_scale: 1.0, gain: 3.0, loss: 0  },
  // 2fort sewers micspam classic
  sewers:  { codec: 'steam',   position: 'water',  hp: 0, lp: 20000, voice_scale: 1.0, gain: 2.0, loss: 0  },
  // Terrible connection
  laggy:   { codec: 'steam',   position: 'open',   hp: 0, lp: 20000, voice_scale: 1.0, gain: 1.0, loss: 18 }
};

/* -------------------------------------------------------------------------
 * Codec profiles. Every profile runs the bundled libopus; only `steam` is
 * calibrated against a real TF2 recording.
 *
 *   codecRate   : Opus sample rate (8/12/16/24/48 kHz)
 *   bitrate     : bits per second at snd_bits 16 (CBR, 20 ms frames)
 *   application : 'voip' (SILK/hybrid capable) or 'lowdelay' (CELT only)
 *   signal      : Opus signal hint; 'voice' keeps music in hybrid mode,
 *                 matching the SILK/CELT crossover seen in the recording
 *   decoderEq   : optional FIR (linear gains interpolated between points)
 *                 applied to decoded audio at codecRate
 *   voiceRate   : rate at which the engine receives decoded voice and runs
 *                 its auto-gain (128-sample blocks)
 *   mixer       : how voiceRate is converted to the 44.1 kHz mixer:
 *                 'sinc' (band-limited) or 'linear' (Source-style interp)
 *   status      : 'measured' | 'experimental' | 'modeled'
 * ------------------------------------------------------------------------- */
const CODEC_PROFILES = {
  steam: {
    displayName: 'Steam voice (Opus 24 kHz / 32 kbps)',
    codecRate: 24000, bitrate: 32000, application: 'voip', signal: 'voice',
    // The recorded hybrid high band sits ~2.5 dB below libopus 1.6.1's,
    // with a band edge just under 12 kHz (see tests/REFERENCE_2026.md).
    decoderEq: {
      taps: 95,
      freqs:   [0, 7300, 7800, 10500, 11000, 11500, 11800, 12000],
      gainsDb: [0, 0,   -2.5, -2.5,  -2.5,  -2.5,  -2.5,  -60]
    },
    voiceRate: 44100, mixer: 'sinc', status: 'measured'
  },
  // Optional fullband profile, NOT a verified TF2-era or native-rate preset.
  steam_48: {
    displayName: 'Fullband Opus (48 kHz / 64 kbps, experimental)',
    codecRate: 48000, bitrate: 64000, application: 'voip', signal: 'voice',
    voiceRate: 44100, mixer: 'sinc', status: 'experimental'
  },
  // vaudio_celt ran CELT at 22.05 kHz / ~22 kbps. Opus's CELT layer is its
  // descendant; this is a stand-in, not the original 0.x bitstream.
  celt_22: {
    displayName: 'CELT era (Opus CELT layer, 22 kbps)',
    codecRate: 24000, bitrate: 22000, application: 'lowdelay', signal: 'auto',
    voiceRate: 22050, mixer: 'linear', status: 'modeled'
  },
  celt_44: {
    displayName: 'CELT high (Opus CELT layer, 44 kbps)',
    codecRate: 48000, bitrate: 44000, application: 'lowdelay', signal: 'auto',
    voiceRate: 44100, mixer: 'sinc', status: 'modeled'
  },
  // vaudio_speex was 8 kHz narrowband CELP. SILK is a different LPC codec
  // with a similar narrowband character; this is a stand-in.
  speex: {
    displayName: 'Narrowband (Opus SILK, 8 kHz / 8 kbps)',
    codecRate: 8000, bitrate: 8000, application: 'voip', signal: 'voice',
    voiceRate: 11025, mixer: 'linear', status: 'modeled'
  }
};

/* -------------------------------------------------------------------------
 * Receiver voice path, fitted to the 2026 voice_loopback recording:
 *
 *   autoGain  : per 128-sample block, the next gain brings the block's mean
 *               |x| to avgGain of full scale (voice_avggain), capped at
 *               maxGain (effective voice_maxgain), ramped linearly across the
 *               following block and clamped to int16. The recording shows
 *               this signature: mean |y| = 0.49-0.52 of a hard clip ceiling
 *               that ~13% of samples reach, gain updates at 44100/128 Hz.
 *   outputFir : gentle post-mixer rolloff measured above 12 kHz
 *   volume    : output level. The recording's ceiling sat at -16.4 dBFS, but
 *               that includes the owner's game/OS volume, so it is a setting.
 * ------------------------------------------------------------------------- */
const VOICE_ENGINE = {
  mixRate: 44100,
  autoGain: { blockSize: 128, avgGain: 0.5, maxGain: 16 },
  outputFir: [0.1, 0.8, 0.1],
  volume: 0.5
};

/* -------------------------------------------------------------------------
 * DSP presets — Source engine dsp_room ids 0-29.
 *
 * These are transcribed from Valve's scripts/dsp_presets.txt. Each preset
 * is a serial (LINEAR) chain of processors, exactly as in the engine:
 *
 *   dfr — diffusor: n series allpass delays
 *         { size (scales 13-41 ms base delays), ndly (1-4), fb }
 *   rva — parallel reverb: n feedback comb delays
 *         { sizeMax/sizeMin (delay spread, ms), ndly, fb, gain,
 *           cutoff (Hz low-pass), fpar (1 = filter inside feedback loop),
 *           fmod (delay modulation depth, ms), rate (mod rate, Hz) }
 *   dly — feedback echo { delay (ms), fb, gain, cutoff (Hz in loop) }
 *   amp — amplitude modulator / distortion
 *         { gain, vthresh, distmix, modrate (Hz), moddepth, modglide (ms) }
 *   mdy — modulated delay { delay (ms), fb, gain, modrate, moddepth, modglide }
 *
 * `mix` is the wet/dry crossfade; the engine ranges it 0.2-0.7 with
 * listener distance, we use the midpoint. Preset 99 is the emulator's
 * custom slot (duration/decay/mix mapped onto an RVA).
 * ------------------------------------------------------------------------- */
const DSP_PRESETS = {
  0:  { name: 'Off (NULL)',        mix: 0.00, chain: [] },
  1:  { name: 'Generic (AUTO)',    mix: 0.00, chain: [] },
  2:  { name: 'Metal Small',       mix: 0.45, chain: [
        { type: 'rva', sizeMax: 80, sizeMin: 30, ndly: 4, fb: 0.85, gain: 1.1, cutoff: 4000, fpar: 1, fmod: 0, rate: 0 } ] },
  3:  { name: 'Metal Medium',      mix: 0.45, chain: [
        { type: 'rva', sizeMax: 80, sizeMin: 30, ndly: 4, fb: 0.90, gain: 1.4, cutoff: 4000, fpar: 1, fmod: 0, rate: 0 } ] },
  4:  { name: 'Metal Large',       mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 3, fb: 0.1483 },
        { type: 'rva', sizeMax: 100, sizeMin: 30, ndly: 4, fb: 0.95, gain: 1.8, cutoff: 4000, fpar: 1, fmod: 0, rate: 0 } ] },
  5:  { name: 'Tunnel Small',      mix: 0.45, chain: [
        { type: 'rva', sizeMax: 50, sizeMin: 8, ndly: 2, fb: 0.92, gain: 1.1, cutoff: 6000, fpar: 1, fmod: 0, rate: 0 } ] },
  6:  { name: 'Tunnel Medium',     mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 100, sizeMin: 15, ndly: 2, fb: 0.92, gain: 1.1, cutoff: 5000, fpar: 1, fmod: 0, rate: 0 } ] },
  7:  { name: 'Tunnel Large',      mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 3, fb: 0.15 },
        { type: 'rva', sizeMax: 120, sizeMin: 25, ndly: 2, fb: 0.95, gain: 1.1, cutoff: 4000, fpar: 1, fmod: 0, rate: 0 } ] },
  8:  { name: 'Chamber Small',     mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 6, fb: 0.90, gain: 1.4, cutoff: 5000, fpar: 1, fmod: 4, rate: 3.48 } ] },
  9:  { name: 'Chamber Medium',    mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 6, fb: 0.90, gain: 1.4, cutoff: 6000, fpar: 1, fmod: 4, rate: 3.48 } ] },
  10: { name: 'Chamber Large',     mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 9, fb: 0.90, gain: 1.4, cutoff: 6000, fpar: 1, fmod: 4, rate: 3.48 } ] },
  11: { name: 'Brite Small',       mix: 0.45, chain: [
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 3, fb: 0.90, gain: 1.0, cutoff: 5000, fpar: 1, fmod: 0, rate: 0 } ] },
  12: { name: 'Brite Medium',      mix: 0.45, chain: [
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 5, fb: 0.90, gain: 1.0, cutoff: 5000, fpar: 1, fmod: 0, rate: 0 } ] },
  13: { name: 'Brite Large',       mix: 0.45, chain: [
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 6, fb: 0.90, gain: 1.0, cutoff: 6000, fpar: 0, fmod: 0, rate: 0 } ] },
  14: { name: 'Water 1',           mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 3, fb: 0.15 },
        { type: 'amp', gain: 1.0, vthresh: 0, distmix: 0, modrate: 10.0, moddepth: 0.6, modglide: 80 },
        { type: 'rva', sizeMax: 82, sizeMin: 59, ndly: 2, fb: 0.40, gain: 2.0, cutoff: 1800, fpar: 0, fmod: 10, rate: 3.0 } ] },
  15: { name: 'Water 2',           mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 5, fb: 0.90, gain: 1.4, cutoff: 1000, fpar: 0, fmod: 4, rate: 3.48 } ] },
  16: { name: 'Water 3',           mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 7, fb: 0.90, gain: 1.0, cutoff: 1000, fpar: 0, fmod: 4, rate: 3.48 },
        { type: 'mdy', delay: 500, fb: 0.4, gain: 1.0, modrate: 2.0, moddepth: 0.01, modglide: 15 } ] },
  17: { name: 'Concrete Small',    mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 6, fb: 0.90, gain: 1.4, cutoff: 4000, fpar: 1, fmod: 4, rate: 3.48 } ] },
  18: { name: 'Concrete Medium',   mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 7, fb: 0.90, gain: 1.4, cutoff: 3500, fpar: 1, fmod: 4, rate: 3.48 } ] },
  19: { name: 'Concrete Large',    mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 8, fb: 0.90, gain: 1.4, cutoff: 3000, fpar: 1, fmod: 4, rate: 3.48 } ] },
  20: { name: 'Outside Small',     mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'dly', delay: 300, fb: 0.5, gain: 0.84, cutoff: 2000 } ] },
  21: { name: 'Outside Medium',    mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'dly', delay: 400, fb: 0.5, gain: 0.84, cutoff: 1500 } ] },
  22: { name: 'Outside Large',     mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'dly', delay: 750, fb: 0.5, gain: 0.84, cutoff: 1000 } ] },
  23: { name: 'Cavern Small',      mix: 0.45, chain: [
        { type: 'dly', delay: 150, fb: 0.5, gain: 0.84, cutoff: 3000 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 1, fb: 0.90, gain: 1.0, cutoff: 1500, fpar: 1, fmod: 4, rate: 3.48 } ] },
  24: { name: 'Cavern Medium',     mix: 0.45, chain: [
        { type: 'dly', delay: 200, fb: 0.7, gain: 0.6, cutoff: 3000 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 7, fb: 0.90, gain: 1.0, cutoff: 1500, fpar: 1, fmod: 4, rate: 3.48 } ] },
  25: { name: 'Cavern Large',      mix: 0.45, chain: [
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 },
        { type: 'dly', delay: 300, fb: 0.7, gain: 0.6, cutoff: 3000 },
        { type: 'rva', sizeMax: 50, sizeMin: 20, ndly: 9, fb: 0.90, gain: 1.0, cutoff: 1500, fpar: 1, fmod: 4, rate: 3.48 } ] },
  26: { name: 'Weirdo 1',          mix: 0.45, chain: [
        { type: 'dly', delay: 400, fb: 0.5, gain: 0.6, cutoff: 1500 },
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 } ] },
  27: { name: 'Weirdo 2',          mix: 0.45, chain: [
        { type: 'dly', delay: 400, fb: 0.5, gain: 0.6, cutoff: 1500 },
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 } ] },
  28: { name: 'Weirdo 3',          mix: 0.45, chain: [
        { type: 'dly', delay: 400, fb: 0.5, gain: 0.6, cutoff: 1500 },
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 } ] },
  29: { name: 'Weirdo 4',          mix: 0.45, chain: [
        { type: 'dly', delay: 400, fb: 0.5, gain: 0.6, cutoff: 1500 },
        { type: 'dfr', size: 1.0, ndly: 2, fb: 0.15 } ] },
  // Emulator-only custom slot: audio.js maps duration/decay/mix onto an RVA.
  99: { name: 'Custom',            mix: 0.25, custom: true, duration: 1.5, decay: 3.0 }
};

// Legacy map for the <select id="env"> UI — keeps old "room/locker/hall" values working.
// Each alias points at an authentic DSP preset id.
const ENV_ALIAS = {
  none:   0,
  dry:    0,
  room:   17,  // Concrete Small — small echo-y spawn room
  locker: 8,   // Chamber Small — tighter, narrow
  hall:   22,  // Outside Large — open slap echo
  custom: 99
};

/* -------------------------------------------------------------------------
 * Listener position presets — an optional effect layer. Each key maps a
 * location to a dsp_room preset plus any extra low-pass (underwater). The
 * reference loopback recording was dry, so whether and how TF2 routes voice
 * through room DSP is not established by it; "open" (0) is the measured path.
 * ------------------------------------------------------------------------- */
const LISTENER_POSITIONS = {
  open:       { label: 'Open / Outdoor',        dsp: 0,  extraLpf: null, notes: 'Hightower mid, 2fort battlements' },
  hallway:    { label: 'Hallway / Corridor',    dsp: 22, extraLpf: null, notes: 'Badwater connectors, Upward last' },
  small_room: { label: 'Small Room / Spawn',    dsp: 17, extraLpf: null, notes: 'Spawn rooms, cap-point huts' },
  tunnel:     { label: 'Tunnel',                dsp: 6,  extraLpf: null, notes: '2fort sewers, Upward 1st tunnel' },
  tunnel_big: { label: 'Big Tunnel',            dsp: 7,  extraLpf: null, notes: 'Thundermountain mine shafts' },
  cavern:     { label: 'Cavern',                dsp: 24, extraLpf: null, notes: 'Snakewater connectors' },
  hangar:     { label: 'Hangar / Warehouse',    dsp: 10, extraLpf: null, notes: 'Process main, Gullywash mid' },
  chamber:    { label: 'Concrete Chamber',      dsp: 19, extraLpf: null, notes: 'Dustbowl stage 3, Gorge last' },
  water:      { label: 'Underwater',            dsp: 14, extraLpf: 900,  notes: '2fort water room, Turbine vents' },
  metal:      { label: 'Metal Room',            dsp: 4,  extraLpf: null, notes: 'Harvest silo, Process 2nd' }
};

const FCVAR = { NONE: 0, CHEAT: 1 << 0, READONLY: 1 << 1, SERVER: 1 << 2 };
