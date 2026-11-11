// Player types for the simulator: scripted random, greedy (plays the odds), always-bluff, a colluding pair, and a local model.

import { cardsBluff, cardsColluder, cardsGreedy, cardsOutOfTurn, cardsProbes, cardsRandom, rankOf } from './cards.mjs';
import { diceBluff, diceColluder, diceGreedy, diceOutOfTurn, diceProbes, diceRandom } from './dice.mjs';
import { diceModel } from './ollama.mjs';

export const PLAYERS = {
  'cup-and-claim': { random: diceRandom, greedy: diceGreedy, bluff: diceBluff, colluder: diceColluder, model: diceModel },
  'sealed-hand': { random: cardsRandom, greedy: cardsGreedy, bluff: cardsBluff, colluder: cardsColluder },
};
export const PROBES = { 'cup-and-claim': diceProbes, 'sealed-hand': cardsProbes };
export const OUT_OF_TURN = { 'cup-and-claim': diceOutOfTurn, 'sealed-hand': cardsOutOfTurn };

/**
 * The colluders' side channel: what two seats tell each other that the Hall never sees. In real life this would be a chat, a
 * shared process, a second screen. Here it is an object both players hold.
 */
export function makeTeam() {
  const shared = new Map(); // seat -> what it shared, this round
  const seats = [];
  return {
    seats,
    add(seat) { seats.push(seat); },
    partnerOf(seat) { return seats.find((s) => s !== seat) ?? null; },
    share(seat, info) { shared.set(seat, info); },
    read(seat, round) { const info = shared.get(seat); return info && info.round === round ? info : null; },
    /** Sealed Hand: the card from my hand that pairs one in my partner's hand (the partner is the next seat, who gets my pass). */
    passFor(seat, hand) {
      const partner = this.partnerOf(seat);
      const theirs = shared.get(partner)?.hand ?? [];
      const ranks = new Set(theirs.map(rankOf));
      return hand.find((c) => ranks.has(rankOf(c))) ?? null;
    },
  };
}
