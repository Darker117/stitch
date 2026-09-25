// Built-in scenario templates. Each becomes a fully editable scenario.
import { nanoid } from 'nanoid'
import type { CreatorField, OpeningType, PlotComponents, Scenario, StoryCard, StoryCardType } from '@shared/types'
import { db } from '@/stores/db'
import { DEFAULT_INSTRUCTIONS, emptyPlot, newCard, newScenario } from './engine/defaults'

export type TemplateId = 'random' | 'empty' | 'fantasy' | 'mystery' | 'zombie' | 'cyberpunk' | 'apocalyptic'

type CardSeed = { type: StoryCardType; customType?: string; name: string; entry: string; triggers: string; notes?: string }

interface ScenarioSeed {
  title: string
  description: string
  tags: string[]
  openingType: OpeningType
  opening: string
  plot: Partial<PlotComponents>
  cards: CardSeed[]
  creatorFields?: Omit<CreatorField, 'id'>[]
  contentRating?: Scenario['contentRating']
  children?: ScenarioSeed[]
}

export interface TemplateDef {
  id: TemplateId
  name: string
  blurb: string
  seed?: ScenarioSeed
}

const style = (lines: string): string => `${DEFAULT_INSTRUCTIONS}\n${lines}`

const FANTASY: ScenarioSeed = {
  title: 'The Ember Crown',
  description:
    'The old king is dead, his crown is missing, and the kingdom of Larion teeters on the edge of war. Create your hero and step into a realm of knights, mages and very old debts.',
  tags: ['fantasy', 'intrigue', 'adventure'],
  openingType: 'characterCreator',
  opening:
    'Larion is a kingdom of river cities and old forests, held together for three hundred years by the Ember Crown — a circlet said to carry the will of the first king. Three nights ago the crown vanished from the royal vault, and King Aldric died in the same hour.\n\nYou are ${character.name}, a ${character.race} ${character.class}, and you have just arrived in ${character.location}. Rumours travel faster than riders, and everyone you meet seems to want something from you.',
  plot: {
    aiInstructions: style('- Classic high fantasy with political intrigue. Magic is rare, costly and a little frightening.\n- Give nobles, guards and commoners distinct voices and agendas.'),
    plotEssentials:
      'The Ember Crown has been stolen and King Aldric is dead. Queen-regent Seraphine rules in his place while the four dukes gather their armies. Magic is feared and regulated by the Circle of Ash. Whoever wears the crown can command the loyalty of Larion\'s ancient oath-bound guardians.',
    authorsNote: 'Tone: grounded high fantasy, vivid and tactile. Every choice has a political consequence.'
  },
  creatorFields: [
    { label: 'Class', cardType: 'class' },
    { label: 'Race', cardType: 'race' },
    { label: 'Location', cardType: 'location' }
  ],
  cards: [
    { type: 'class', name: 'Knight', entry: 'Knights of Larion swear an oath to the crown, not the king. Trained in longsword, lance and shield from the age of seven, they are respected by commoners and resented by the dukes whose power they check.', triggers: 'knight, oath, sword', notes: 'Sworn blade of the crown — steel, honour and a vow that outlives kings.' },
    { type: 'class', name: 'Mage', entry: 'Mages draw power from ember-stones and their own warmth; every spell leaves them colder. Unlicensed casting is a crime punished by the Circle of Ash, so most mages hide what they are.', triggers: 'mage, magic, spell, ember-stone', notes: 'Spells that cost you warmth, in a kingdom that fears what you can do.' },
    { type: 'class', name: 'Rogue', entry: 'Rogues work the gaps between laws: locks, lies, pockets and rooftops. The Guild of Quiet Hands in Silverfall takes a tithe from every thief in the capital and knows every secret worth selling.', triggers: 'rogue, thief, lockpick, Quiet Hands', notes: 'Locks, lies and rooftops — and a guild that always collects.' },
    { type: 'race', name: 'Human', entry: 'Humans are the most numerous people of Larion — farmers, merchants, soldiers and nobles. Adaptable and ambitious, they hold nearly every seat of power.', triggers: 'human', notes: 'Adaptable and ambitious — the people who rule Larion.' },
    { type: 'race', name: 'Elf', entry: 'The elves of the Thornwood live for centuries and remember the first king personally. Tall, silver-eyed and slow to trust, they signed the Oath of Embers and consider the crown\'s theft a personal insult.', triggers: 'elf, elves, elven', notes: 'Long memories and older grudges; your people remember the first king.' },
    { type: 'race', name: 'Dwarf', entry: 'Dwarves of the Ironroot Hills forged the Ember Crown\'s setting and still claim a share of its legacy. Stout, blunt and superb craftsfolk, they measure people by whether they keep their word.', triggers: 'dwarf, dwarves, dwarven, Ironroot', notes: 'Your ancestors forged the crown\'s setting. They want it back.' },
    { type: 'location', name: 'Silverfall', entry: 'Silverfall is Larion\'s capital, built where the river drops over white cliffs. The royal palace, the Circle of Ash\'s black tower and the crowded Lanternmarket all share its terraces. Since the theft the gates are watched and everyone is searched.', triggers: 'Silverfall, capital, palace, Lanternmarket', notes: 'The capital: palace intrigue, locked gates and a city holding its breath.' },
    { type: 'location', name: 'Thornwood Crossing', entry: 'Thornwood Crossing is a timber village at the edge of the elven forest, built around a toll bridge and an inn called the Crooked Antler. Travellers, smugglers and elven envoys pass through daily.', triggers: 'Thornwood, Crossing, Crooked Antler, inn', notes: 'A frontier village of smugglers, envoys and a very busy inn.' },
    { type: 'character', name: 'Seraphine', entry: 'Queen-regent Seraphine, forty, sharp-featured with silver-streaked dark hair, rules Larion until the crown is found. Brilliant and cold in public, she is quietly terrified that her own son arranged the theft.', triggers: 'Seraphine, queen, regent' },
    { type: 'faction', name: 'Circle of Ash', entry: 'The Circle of Ash licenses and polices magic in Larion. Its grey-robed wardens wear ash-smudged masks and answer only to the throne. They want the crown found, and any mage involved burned.', triggers: 'Circle of Ash, warden, wardens, ash-mask' }
  ]
}

const MYSTERY: ScenarioSeed = {
  title: 'Rain on Mercer Street',
  description:
    'Port Halden, 1947. A wealthy heiress walks into your office with a missing brother, a pawn ticket and a lie. Solve the case before the city swallows it whole.',
  tags: ['mystery', 'noir', 'detective'],
  openingType: 'story',
  opening:
    'The rain hasn\'t stopped in three days. It drums on the window of your second-floor office on Mercer Street, where the gold letters on the glass still read ${What is your name?} — Private Investigations.\n\nYou\'re pouring the last of the rye when the door opens without a knock. The woman in the doorway wears a green coat worth more than your rent, and she holds a pawn ticket like it might bite her.\n\n"My brother is missing," she says. "The police won\'t help me. They say you will — for the right price."',
  plot: {
    aiInstructions: style('- Hard-boiled 1940s noir: terse, atmospheric narration with dry wit.\n- Plant clues fairly. The mystery has one consistent solution; reveal it only through investigation.'),
    plotEssentials:
      'Setting: Port Halden, 1947, a rain-soaked harbour city run by old money and older grudges. The client is Vivian Ashcombe. Her brother Teddy vanished four days ago. The pawn ticket is from Lou\'s Pawn on Dock Street.\nSecret (reveal only through clues): Teddy witnessed a Harbor Syndicate murder and faked his own disappearance. Vivian knows he is alive and is using the detective to find him before the Syndicate does.',
    authorsNote: 'Tone: moody noir. Rain, smoke, neon, secrets. Everyone lies a little.'
  },
  cards: [
    { type: 'character', name: 'Vivian Ashcombe', entry: 'Vivian Ashcombe, 29, heiress to the Ashcombe shipping fortune. Auburn hair, green coat, pearl earrings, steady voice. She is protective of her brother and hides that she has received a coded telegram from him.', triggers: 'Vivian, Ashcombe, client, heiress' },
    { type: 'character', name: 'Teddy Ashcombe', entry: 'Theodore "Teddy" Ashcombe, 24, charming gambler and the family disappointment. He owes money at the Blue Heron Club and saw something on Pier 9 he shouldn\'t have.', triggers: 'Teddy, brother, Theodore' },
    { type: 'character', name: 'Lieutenant Frank Doyle', entry: 'Lt. Frank Doyle of the Port Halden police, 50, heavy-set, tired eyes, rumpled hat. Honest enough to be dangerous to himself; he knows the Syndicate owns half his precinct.', triggers: 'Doyle, lieutenant, police, cops' },
    { type: 'location', name: "Lou's Pawn", entry: "Lou's Pawn on Dock Street is a cramped shop of dusty instruments and unclaimed watches. Lou Petrakis, the owner, keeps a ledger under the counter and a shotgun beside it.", triggers: "Lou, pawn, pawnshop, Dock Street, pawn ticket" },
    { type: 'location', name: 'The Blue Heron Club', entry: 'The Blue Heron is a jazz club and illegal card room above the fish market. Smoke, brass, blue lights and a back room where the Syndicate settles debts.', triggers: 'Blue Heron, club, jazz' },
    { type: 'faction', name: 'Harbor Syndicate', entry: 'The Harbor Syndicate controls the docks, the unions and several judges. Led by the soft-spoken Mr. Castellane, it prefers bribes to bullets — until it doesn\'t.', triggers: 'Syndicate, Castellane, mob, Pier 9' }
  ]
}

const ZOMBIE: ScenarioSeed = {
  title: 'Day Nine',
  description: 'Nine days after the outbreak, the city has gone quiet. You have a crowbar, half a bottle of water and a radio that just crackled to life.',
  tags: ['zombie', 'survival', 'horror'],
  openingType: 'story',
  opening:
    'Day nine. The city has stopped screaming.\n\nYou wake on the floor of the pharmacy storeroom, the barricade of shelving still wedged against the door. Something shuffles past outside — slow, dragging, patient. Your water bottle is half full. Your crowbar is where you left it.\n\nThen the radio on the shelf crackles: "...anyone hearing this... St. Agnes Hospital, rooftop... helicopter at dawn... we can\'t wait..." Static swallows the rest.',
  plot: {
    aiInstructions: style('- Tense survival horror. Emphasise scarcity, sound, dread and hard choices.\n- The infected are dangerous; carelessness has consequences, but the player can survive through wit.'),
    plotEssentials:
      'The outbreak began nine days ago. The infected ("shamblers") are slow alone but deadly in crowds and drawn by noise. A bite turns a person within hours. An evacuation helicopter will land on the St. Agnes Hospital roof at dawn tomorrow. Food, water and medicine are scarce.',
    authorsNote: 'Tone: claustrophobic, quiet dread punctuated by sudden danger.'
  },
  cards: [
    { type: 'custom', customType: 'Creature', name: 'Shamblers', entry: 'Shamblers are the infected: grey-skinned, milky-eyed, slow and relentless. They hunt by sound, gather into hordes around noise, and can sense living people at close range. Destroying the brain stops them.', triggers: 'shambler, shamblers, infected, zombie, zombies, horde, dead' },
    { type: 'character', name: 'Maya Torres', entry: 'Maya Torres, 34, ER nurse, short black hair, scrubs under a torn rain jacket, carries a fire axe and a medkit. Pragmatic and kind but will not risk her group for strangers. She is hiding a bite on her forearm.', triggers: 'Maya, Torres, nurse' },
    { type: 'location', name: 'St. Agnes Hospital', entry: 'St. Agnes Hospital is twelve blocks north. Its lower floors are overrun; survivors hold the roof and the top floor behind a barricaded stairwell. The helipad is on the east wing.', triggers: 'St. Agnes, hospital, rooftop, helicopter, helipad' },
    { type: 'location', name: 'Riverside Pharmacy', entry: 'The Riverside Pharmacy where the player sheltered: shattered front windows, looted aisles, a locked storeroom with a back door onto an alley full of bins.', triggers: 'pharmacy, storeroom, Riverside' },
    { type: 'faction', name: 'The Scavs', entry: 'The Scavs are an armed gang of looters in a converted garbage truck. They trade in medicine and take what they want. Their leader, Brick, is clever, cruel and open to deals.', triggers: 'Scavs, Brick, looters, gang, garbage truck' }
  ]
}

const CYBERPUNK: ScenarioSeed = {
  title: 'Neon Ghosts',
  description: 'Neo-Kowloon, 2089. A stolen chip in your skull will cook your brain in 24 hours — and three corporations want it back.',
  tags: ['cyberpunk', 'sci-fi', 'noir'],
  openingType: 'story',
  opening:
    'The rain in Neo-Kowloon tastes like copper and ozone. You\'re crouched under a noodle stall\'s awning on Level 40, watching holo-ads bleed colour across the puddles, when your ocular HUD flashes red.\n\nTHERMAL WARNING — IMPLANT CORE 41°C.\n\nThe chip you lifted from the Kiroshi Dynamics vault is heating up. Your fixer said you\'d have a week. Your fixer lied. Across the street, two men in identical grey coats step out of a car with no plates.',
  plot: {
    aiInstructions: style('- Cyberpunk noir: neon, rain, chrome and street slang. Technology always has a cost.\n- Corporations are ruthless and competent; the street has its own loyalties.'),
    plotEssentials:
      'Year 2089. Neo-Kowloon is a vertical megacity of 200 levels: corporate spires above, the flooded Undercity below. The player is a data courier with a stolen Kiroshi Dynamics prototype chip — the Ghost chip — in their neural implant. It will overheat and kill them within 24 hours unless a skilled ripperdoc extracts it. Kiroshi\'s retrieval team is hunting them.',
    authorsNote: 'Tone: fast, tense, stylish. Short sentences in action scenes.'
  },
  cards: [
    { type: 'faction', name: 'Kiroshi Dynamics', entry: 'Kiroshi Dynamics builds neural implants and owns the top thirty levels of Neo-Kowloon. Its retrieval teams — "Greycoats" — are chrome-boosted, polite and utterly without mercy.', triggers: 'Kiroshi, Greycoats, grey coats, corp, corporation' },
    { type: 'character', name: 'Doc Halloran', entry: 'Doc Halloran, 60s, ripperdoc with trembling organic hands and steady chrome ones. Runs a clinic behind a laundromat in the Undercity. Owes the player a favour but hates Kiroshi more than he likes anyone.', triggers: 'Halloran, Doc, ripperdoc, clinic' },
    { type: 'character', name: 'Jinx', entry: 'Jinx, 26, the player\'s fixer: neon-pink undercut, mirrored lenses, fast talker. She sold the player out to a rival corp, Aurum Biotech, and is now trying to buy her way back into the player\'s good graces.', triggers: 'Jinx, fixer' },
    { type: 'location', name: 'Level 40 Night Market', entry: 'The Level 40 Night Market is a maze of noodle stalls, black-market implant vendors and holo-shrines under a leaking skybridge. Everyone watches; nobody talks to Kiroshi.', triggers: 'Level 40, night market, market, noodle stall' },
    { type: 'location', name: 'The Undercity', entry: 'The Undercity is the flooded bottom of Neo-Kowloon: rusted walkways over black water, pirate power taps, and gangs who shoot drones on sight. Corporate signals barely reach it.', triggers: 'Undercity, flooded, lower levels' },
    { type: 'custom', customType: 'Tech', name: 'Ghost chip', entry: 'The Ghost chip is a Kiroshi prototype that can impersonate any neural ID. Installed in the player\'s implant, it overheats over 24 hours. It sometimes whispers fragments of data — including a Kiroshi board member\'s secrets.', triggers: 'chip, Ghost chip, implant, HUD, overheating' }
  ]
}

const APOCALYPTIC: ScenarioSeed = {
  title: 'After the Ash',
  description: 'Forty years after the bombs, the Ashlands belong to whoever can hold them. Choose who you are — and how you survive.',
  tags: ['post-apocalyptic', 'survival', 'wasteland'],
  openingType: 'multipleChoice',
  opening: 'Who are you in the Ashlands?',
  plot: {
    aiInstructions: style('- Post-apocalyptic survival with dark humour and hope in small things.\n- Radiation, thirst and scarcity are constant pressures. Trust is earned.'),
    plotEssentials:
      'Forty years after a nuclear war. The Ashlands are a radioactive desert of ruined cities, raider clans and fortified settlements. Clean water is currency. The Iron Covenant, a militarised theocracy, is expanding west and conscripting every settlement it takes.',
    authorsNote: 'Tone: gritty, sun-bleached, occasionally wry.'
  },
  cards: [
    { type: 'faction', name: 'Iron Covenant', entry: 'The Iron Covenant worships the "Machine Saints" of the old world and rules through armoured convoys and water rationing. Its soldiers wear grey plate stamped with a cog-and-halo. Deserters are hunted.', triggers: 'Iron Covenant, Covenant, cog-and-halo, convoy' },
    { type: 'location', name: 'Rustwater', entry: 'Rustwater is a neutral trading town built in a dry reservoir. Its Water Council sells clean water by the litre; its market sells everything else. Violence inside the walls is punished by exile.', triggers: 'Rustwater, reservoir, Water Council, market' },
    { type: 'custom', customType: 'Hazard', name: 'Radstorms', entry: 'Radstorms are green-tinged dust storms that sweep the Ashlands without warning. They blind travellers, fry electronics and leave dangerous radiation. Shelter or a sealed suit is the only protection.', triggers: 'radstorm, radstorms, storm, dust storm, radiation' }
  ],
  children: [
    {
      title: 'Wasteland Scavenger',
      description: 'You pick the bones of the old world for a living.',
      tags: [],
      openingType: 'story',
      opening:
        'You\'ve picked the bones of the old world for eleven years, and you\'ve never seen a door like this one. Half-buried in the dunes outside the ruins of Carrow, a steel hatch stamped with a faded government seal has been exposed by last night\'s radstorm.\n\nYour Geiger counter clicks lazily. Your canteen sloshes, nearly empty. Far to the east, a plume of dust marks an Iron Covenant convoy heading your way.',
      plot: {},
      cards: [
        { type: 'location', name: 'Carrow', entry: 'Carrow is a ruined pre-war city of toppled towers and sand-drowned streets, picked over by scavengers. A pre-war military bunker lies somewhere beneath it.', triggers: 'Carrow, ruins, bunker, hatch' }
      ]
    },
    {
      title: 'Vault Dweller',
      description: 'The vault door opens for the first time in forty years.',
      tags: [],
      openingType: 'story',
      opening:
        'The vault door hasn\'t opened in forty years. Today it opens for you.\n\nThe Overseer\'s hand is heavy on your shoulder as the great steel wheel groans and turns. "The water purifier is failing," she says quietly, so the crowd behind you can\'t hear. "Find a replacement chip. Don\'t trust anyone. And don\'t come back without it."\n\nLight pours in — white, blinding, and hotter than anything you\'ve ever felt.',
      plot: {},
      cards: [
        { type: 'character', name: 'The Overseer', entry: 'Overseer Ilse Varga, 58, steel-grey braid, pressed blue uniform. She has ruled Vault 12 for twenty years and hides that the vault has less than a month of clean water left.', triggers: 'Overseer, Varga, Ilse, vault' }
      ]
    },
    {
      title: 'Covenant Deserter',
      description: 'You ran from the Iron Covenant at midnight.',
      tags: [],
      openingType: 'story',
      opening:
        'You ran at midnight, still wearing the grey plate of the Iron Covenant, and you haven\'t stopped since. Now the sun is rising over the salt flats, your armour is too hot to touch, and the cog-and-halo on your chest is a target visible for miles.\n\nBehind you, faint but growing, you hear the rumble of engines. Ahead, the walls of Rustwater shimmer in the heat.',
      plot: {},
      cards: [
        { type: 'character', name: 'Preceptor Kael', entry: 'Preceptor Kael, 45, the Covenant officer who trained the player. Scarred jaw, calm voice, absolute faith. He leads the hunt personally and believes the deserter can still be "redeemed".', triggers: 'Kael, Preceptor, hunters' }
      ]
    }
  ]
}

export const TEMPLATES: TemplateDef[] = [
  { id: 'random', name: 'Random', blurb: 'Surprise me with one of the built-in worlds.' },
  { id: 'empty', name: 'Empty', blurb: 'A blank page. Build everything yourself.' },
  { id: 'fantasy', name: 'Fantasy', blurb: 'Knights, mages and a stolen crown.', seed: FANTASY },
  { id: 'mystery', name: 'Mystery', blurb: 'A 1940s noir case in the rain.', seed: MYSTERY },
  { id: 'zombie', name: 'Zombie', blurb: 'Survive the ninth day of the outbreak.', seed: ZOMBIE },
  { id: 'cyberpunk', name: 'Cyberpunk', blurb: 'A stolen chip and 24 hours to live.', seed: CYBERPUNK },
  { id: 'apocalyptic', name: 'Apocalyptic', blurb: 'Forty years after the bombs.', seed: APOCALYPTIC }
]

function cardsFrom(seeds: CardSeed[]): StoryCard[] {
  return seeds.map((s) => newCard({ ...s, notes: s.notes ?? '' }))
}

function buildScenario(seed: ScenarioSeed, template: TemplateId, parentId?: string): Scenario[] {
  const id = nanoid(10)
  const children = (seed.children ?? []).flatMap((c) => buildScenario(c, template, id))
  const direct = children.filter((c) => c.parentId === id)
  const s = newScenario({
    id,
    parentId,
    title: seed.title,
    description: seed.description,
    tags: seed.tags,
    openingType: seed.openingType,
    opening: seed.opening,
    plot: emptyPlot(seed.plot),
    cards: cardsFrom(seed.cards),
    creatorFields: (seed.creatorFields ?? []).map((f) => ({ ...f, id: nanoid(8) })),
    choices: direct.map((c) => c.id),
    contentRating: seed.contentRating ?? 'teen',
    template
  })
  return [s, ...children]
}

/** Build (without saving) the scenario docs for a template: [top-level, ...children]. */
export function scenariosFromTemplate(id: TemplateId): Scenario[] {
  let tpl = TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[1]
  if (tpl.id === 'random') {
    const pool = TEMPLATES.filter((t) => t.seed)
    tpl = pool[Math.floor(Math.random() * pool.length)]
  }
  if (!tpl.seed) return [newScenario({ template: 'empty' })]
  return buildScenario(tpl.seed, tpl.id)
}

/** Create (and persist) a scenario from a template. Returns the top-level scenario. */
export async function createFromTemplate(id: TemplateId): Promise<Scenario> {
  const all = scenariosFromTemplate(id)
  // Children first so the parent never points at missing docs.
  for (const s of all.slice(1)) await db.put('scenarios', s)
  await db.put('scenarios', all[0])
  return all[0]
}
