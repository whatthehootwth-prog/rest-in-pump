import { randomInt } from 'node:crypto';

/**
 * Random silly names, given by the server to every player when they join (like their walk style, they can't
 * be changed). Always "Adjective Noun", at most 16 characters, and unique among the players online.
 */
const ADJECTIVES = [
  'Soggy', 'Rekt', 'Salty', 'Wobbly', 'Sweaty', 'Confused', 'Moist', 'Grumpy', 'Broke', 'Spooky', 'Goofy',
  'Clumsy', 'Sleepy', 'Cursed', 'Sticky', 'Dizzy', 'Bald', 'Itchy', 'Crying', 'Tiny', 'Chunky', 'Bonked',
  'Wrecked', 'Panicky', 'Crusty', 'Lumpy', 'Sneezy', 'Haunted', 'Rugged', 'Dusty', 'Feral', 'Shaky',
  'Burnt', 'Leaky', 'Smelly', 'Weepy', 'Jiggly', 'Loud', 'Sus', 'Fried',
];
const NOUNS = [
  'Bagholder', 'Degen', 'Ape', 'Whale', 'Shrimp', 'Paperhand', 'Noodle', 'Potato', 'Goblin', 'Owlet', 'Pigeon',
  'Nugget', 'Pickle', 'Muffin', 'Toaster', 'Gremlin', 'Hodler', 'Moonboy', 'Copelord', 'Gecko', 'Turnip',
  'Dumpling', 'Sock', 'Biscuit', 'Clown', 'Ghost', 'Wizard', 'Raccoon', 'Walrus', 'Burrito', 'Penguin',
  'Jeet', 'Floormat', 'Cabbage', 'Hamster', 'Pancake', 'Dingus', 'Gobbler',
];
const MAX = 16;

export function sillyName(taken: Set<string>, rand: (n: number) => number = randomInt): string {
  for (let i = 0; i < 200; i++) {
    const name = `${ADJECTIVES[rand(ADJECTIVES.length)]} ${NOUNS[rand(NOUNS.length)]}`;
    if (name.length <= MAX && !taken.has(name)) return name;
  }
  // 1,500+ combinations: only reached with an absurd number of players; add a number to stay unique
  for (let n = 2; ; n++) {
    const name = `${NOUNS[rand(NOUNS.length)]} ${n}`;
    if (!taken.has(name)) return name;
  }
}
