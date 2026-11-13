/**
 * Roster.ts — the playable toddlers. Each one is plain data; Toddler.ts and
 * Walker.ts turn an entry into a 3D model, and Hud.ts draws a portrait from it.
 * Everyone shares the same handling (see WALKER_TUNING), so picks are about style.
 *
 * TypeScript tip: a union of string literals ("short" | "curly" | "puffs")
 * means the compiler rejects typos like "puff".
 */
export type HairStyle = "short" | "curly" | "puffs";
export type Accessory = "headphones" | "crown" | "tiara" | "teddy" | "chef" | "nightcap";

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
  accentColor: string; // headphones, cape, bow...
}

export const ROSTER: readonly RosterEntry[] = [
  {
    id: "dj-the-dasher",
    name: "DJ the Dasher",
    tagline: "Fastest feet on the block",
    skinTone: "#6B4226",
    hairColor: "#140c07",
    hairStyle: "short",
    shirtColor: "#ff8a1e",
    walkerColor: "#1f4fff", // royal blue
    walkerTrim: "#ff8a00", // orange
    walkerStripe: "#ff8a00", // orange racing stripes
    accessory: "headphones",
    accentColor: "#ff8a1e",
  },
  {
    id: "adam-the-great",
    name: "Adam The Great",
    tagline: "Ruler of the living room",
    skinTone: "#704529",
    hairColor: "#1a0f08",
    hairStyle: "curly",
    shirtColor: "#f4f4f4",
    walkerColor: "#16a83a", // bold green
    walkerTrim: "#ffc61e", // gold
    walkerStripe: "#e3191f", // red racing stripes
    accessory: "crown",
    accentColor: "#c8102e",
  },
  {
    id: "princess-logan",
    name: "Princess Logan",
    tagline: "Sparkles at top speed",
    skinTone: "#C68E5F",
    hairColor: "#2B1A10",
    hairStyle: "puffs",
    shirtColor: "#c79bff",
    walkerColor: "#ff5fb0",
    walkerTrim: "#9b5cff",
    accessory: "tiara",
    accentColor: "#ff4fa3",
  },
  {
    id: "huggie",
    name: "Huggie",
    tagline: "A walking hug on wheels",
    skinTone: "#A26B3C", // medium tan (existing three are unchanged)
    hairColor: "#3A2212",
    hairStyle: "short",
    shirtColor: "#d4924a", // teddy onesie
    walkerColor: "#e0a05a", // soft orange/tan
    walkerTrim: "#8b5a2b",
    accessory: "teddy",
    accentColor: "#6b3e1f",
  },
  {
    id: "snacks",
    name: "Snacks",
    tagline: "Always ready for a snack break",
    skinTone: "#F0C49A", // light peach
    hairColor: "#7A3E1A", // ginger-brown
    hairStyle: "short",
    shirtColor: "#fff6e0", // chef whites
    walkerColor: "#ffd400", // yellow
    walkerTrim: "#e3191f", // red
    walkerStripe: "#e3191f",
    accessory: "chef",
    accentColor: "#e3191f",
  },
  {
    id: "mr-nap-time",
    name: "MrNapTime",
    tagline: "Champion of quiet time",
    skinTone: "#4E2C18", // medium-deep brown
    hairColor: "#1A0E08",
    hairStyle: "short",
    shirtColor: "#3d2e7a", // pajama purple
    walkerColor: "#4b2e9a", // purple
    walkerTrim: "#1a1a4a", // navy
    walkerStripe: "#ffd400", // gold stars accent
    accessory: "nightcap",
    accentColor: "#ffd400",
  },
];

/** Find a character by id (throws if the id is wrong, so typos show up fast). */
export function character(id: string): RosterEntry {
  const found = ROSTER.find((r) => r.id === id);
  if (!found) throw new Error(`Unknown roster id: ${id}`);
  return found;
}
