/**
 * The trailer narration: when each line starts (seconds), how it should feel, what is shown, and what the voice is
 * asked to say (spelled for good pronunciation). Read by film.ts (timeline) and trailer/voice.mjs (ElevenLabs).
 * Plain data only, so Node can import it directly.
 */
export interface Line { id: string; at: number; text: string; say: string; mood: 'opening' | 'warm' | 'play' | 'ending' }

/** Narration: what is shown, and what the voice is asked to say (spelled for good pronunciation). */
export const LINES: Line[] = [
  { id: '01', at: 1.6, mood: 'opening', text: 'Every meme has a story.', say: 'Every meme... has a story.' },
  { id: '02', at: 4.6, mood: 'opening', text: 'Some become legends.', say: 'Some become legends.' },
  { id: '03', at: 6.9, mood: 'opening', text: 'But sometimes... the world simply moves on.', say: 'But sometimes... the world simply moves on.' },
  { id: '04', at: 10.9, mood: 'opening', text: "But a meme isn't just a chart.", say: "But a meme isn't just a chart." },
  { id: '05', at: 13.2, mood: 'warm', text: "It's the people who remember it.", say: "It's the people who remember it." },
  { id: '06', at: 16.4, mood: 'warm', text: 'And sometimes... all it takes is one.', say: 'And sometimes... all it takes... is one.' },
  { id: '07', at: 21.4, mood: 'warm', text: 'What if those memories could bring everyone together again?', say: 'What if those memories could bring everyone together again?' },
  { id: '08', at: 33.3, mood: 'play', text: 'Welcome to REST IN PUMP!', say: 'Welcome to Rest In Pump!' },
  { id: '09', at: 35.3, mood: 'play', text: 'A multiplayer memorial world where meme communities gather, remember... and get a little ridiculous.', say: 'A multiplayer memorial world, where meme communities gather, remember... and get a little ridiculous.' },
  { id: '10', at: 46.0, mood: 'play', text: 'Choose a meme.', say: 'Choose a meme.' },
  { id: '11', at: 49.4, mood: 'play', text: 'Create its memorial.', say: 'Create its memorial.' },
  { id: '12', at: 52.9, mood: 'play', text: 'And give the community a place to come back to.', say: 'And give the community a place to come back to.' },
  { id: '13', at: 55.8, mood: 'play', text: 'Leave an offering.', say: 'Leave an offering.' },
  { id: '14', at: 57.3, mood: 'play', text: 'Grow the memorial together.', say: 'Grow the memorial... together.' },
  { id: '15', at: 60.9, mood: 'play', text: 'And watch your Memorial NFT evolve as the community grows.', say: 'And watch your Memorial N F T evolve, as the community grows.' },
  { id: '16', at: 70.1, mood: 'warm', text: 'In meme culture, trading often drives the rewards.', say: 'In meme culture, trading often drives the rewards.' },
  { id: '17', at: 74, mood: 'warm', text: 'But what happens when the trading slows down?', say: 'But what happens... when the trading slows down?' },
  { id: '18', at: 77.65, mood: 'play', text: 'REST IN PUMP creates another source.', say: 'Rest In Pump creates another source.' },
  { id: '19', at: 79.95, mood: 'play', text: 'Real game activity helps fund $WTH buybacks and holder rewards.', say: 'Real game activity helps fund W T H buybacks, and holder rewards.' },
  { id: '20', at: 85.3, mood: 'ending', text: "Because a meme's story doesn't end when the hype fades.", say: "Because a meme's story doesn't end... when the hype fades." },
  { id: '21', at: 89.6, mood: 'ending', text: 'As long as someone remembers.', say: 'As long as someone remembers.' },
];
