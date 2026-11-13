/**
 * Roster.ts — the playable toddlers. Each one is plain data; Toddler.ts and
 * Walker.ts turn an entry into a 3D model, and Hud.ts draws a portrait from it.
 * Everyone shares the same handling (see WALKER_TUNING), so picks are about style.
 *
 * The colours and accessories follow the illustrated character portraits
 * (big-head chibi toddlers): headphones, crowns, a teddy hood, a nightcap…
 *
 * TypeScript tip: a union of string literals ("short" | "curly" | "puffs")
 * means the compiler rejects typos like "puff".
 */
export type HairStyle = "short" | "curly" | "puffs";
export type Accessory = "headphones" | "crown" | "tiara" | "teddy" | "nightcap";

export interface RosterEntry {
  id: string;
  name: string;
  tagline: string;
  skinTone: string; // hex, applied to head, ears, arms, hands, legs
  hairColor: string;
  hairStyle: HairStyle;
  shirtColor: string;
  walkerColor: string; // main walker colour
  walkerTrim: string; // tray / bumper colour
  walkerStripe?: string; // optional racing stripes (the `?` makes the field optional)
  accessory: Accessory;
  accentColor: string; // headphones, bow, tassel, hoodie trim…
}

export const ROSTER: readonly RosterEntry[] = [
  {
    id: "dj-the-dasher",
    name: "DJ the Dasher",
    tagline: "Fastest feet on the block",
    skinTone: "#7C3F1E", // rich dark brown
    hairColor: "#120C08",
    hairStyle: "curly", // short tight curls, like the portrait
    shirtColor: "#1A1A1A", // black hoodie
    walkerColor: "#1f4fff", // royal blue
    walkerTrim: "#ff8a00", // orange
    walkerStripe: "#ff8a00",
    accessory: "headphones",
    accentColor: "#FF8A14", // orange cups, zipper, music note
  },
  {
    id: "adam-the-great",
    name: "Adam The Great",
    tagline: "Ruler of the living room",
    skinTone: "#7A4320",
    hairColor: "#140C08",
    hairStyle: "curly",
    shirtColor: "#6B3AA8", // purple top (no cape — the portrait doesn't have one)
    walkerColor: "#16a83a",
    walkerTrim: "#ffc61e",
    walkerStripe: "#e3191f",
    accessory: "crown",
    accentColor: "#FFD24A", // gold crown
  },
  {
    id: "princess-logan",
    name: "Princess Logan",
    tagline: "Sparkles at top speed",
    skinTone: "#C9956A", // light brown
    hairColor: "#2A1810",
    hairStyle: "puffs",
    shirtColor: "#E85AA0", // pink outfit (deeper so it does not wash out in-game)
    walkerColor: "#ff5fb0",
    walkerTrim: "#9b5cff",
    accessory: "tiara",
    accentColor: "#FF4FA3", // pink gem + bow
  },
  {
    id: "huggie",
    name: "Huggie",
    tagline: "A walking hug on wheels",
    skinTone: "#8B4E2A", // warm brown
    hairColor: "#2A1810",
    hairStyle: "short",
    shirtColor: "#E0B57A", // tan teddy-bear onesie / hood
    walkerColor: "#e0a05a",
    walkerTrim: "#8b5a2b",
    accessory: "teddy",
    accentColor: "#C4894A", // slightly deeper fur on the ears
  },
  {
    id: "snacks",
    name: "Snacks",
    tagline: "Always ready for a snack break",
    skinTone: "#F3C7A3", // fair / light peach
    hairColor: "#C9A06A", // light brown golden curls
    hairStyle: "curly",
    shirtColor: "#FFF8E8", // white top with a yellow collar (built in Toddler.ts)
    walkerColor: "#ffd400",
    walkerTrim: "#e3191f",
    walkerStripe: "#e3191f",
    accessory: "crown", // the portrait shows a gold crown, not a bib
    accentColor: "#FFD24A",
  },
  {
    id: "mr-nap-time",
    name: "MrNapTime",
    tagline: "Champion of quiet time",
    skinTone: "#6E3518",
    hairColor: "#140C08",
    hairStyle: "curly", // curls peek out from under the nightcap
    shirtColor: "#5B32A8", // purple pajamas
    walkerColor: "#4b2e9a",
    walkerTrim: "#1a1a4a",
    walkerStripe: "#ffd400",
    accessory: "nightcap",
    accentColor: "#FFD24A", // gold tassel
  },
];

/** Find a character by id (throws if the id is wrong, so typos show up fast). */
export function character(id: string): RosterEntry {
  const found = ROSTER.find((r) => r.id === id);
  if (!found) throw new Error(`Unknown roster id: ${id}`);
  return found;
}
