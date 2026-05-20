export type TradeCategoryItem = {
  /** Stored on listings / users as `tradeCategory`. */
  value: string;
  labelDe: string;
  labelEn: string;
};

export type TradeCategoryGroup = {
  id: string;
  labelDe: string;
  labelEn: string;
  items: TradeCategoryItem[];
};

export const TRADE_CATEGORY_GROUPS: TradeCategoryGroup[] = [
  {
    id: "bau-handwerk",
    labelDe: "Bau & Handwerk",
    labelEn: "Construction & trades",
    items: [
      { value: "Baumeister", labelDe: "Baumeister", labelEn: "Master builder" },
      { value: "Brunnenmeister", labelDe: "Brunnenmeister", labelEn: "Well builder" },
      { value: "Dachdecker", labelDe: "Dachdecker", labelEn: "Roofer" },
      { value: "Elektrotechnik", labelDe: "Elektrotechnik", labelEn: "Electrical engineering" },
      { value: "Gas- und Sanitärtechnik", labelDe: "Gas- und Sanitärtechnik", labelEn: "Gas & plumbing" },
      { value: "Heizungstechnik", labelDe: "Heizungstechnik", labelEn: "Heating technology" },
      {
        value: "Holzbau-Meister (Zimmermeister)",
        labelDe: "Holzbau-Meister (Zimmermeister)",
        labelEn: "Timber construction (carpenter)",
      },
      { value: "Metalltechnik", labelDe: "Metalltechnik", labelEn: "Metal technology" },
      { value: "Schlosser", labelDe: "Schlosser", labelEn: "Locksmith" },
      { value: "Spengler", labelDe: "Spengler", labelEn: "Plumber / sheet metal" },
      { value: "Tischler", labelDe: "Tischler", labelEn: "Joiner / cabinet maker" },
      { value: "Bodenleger", labelDe: "Bodenleger", labelEn: "Floor layer" },
      { value: "Maler & Anstreicher", labelDe: "Maler & Anstreicher", labelEn: "Painter & decorator" },
      { value: "Tapezierer & Dekorateure", labelDe: "Tapezierer & Dekorateure", labelEn: "Wallpaper & interior decorator" },
      { value: "Steinmetz", labelDe: "Steinmetz", labelEn: "Stonemason" },
      { value: "Glaser", labelDe: "Glaser", labelEn: "Glazier" },
      { value: "Hafner", labelDe: "Hafner", labelEn: "Stove / tile mason" },
      { value: "Fliesenleger", labelDe: "Fliesenleger", labelEn: "Tiler" },
      { value: "Rauchfangkehrer", labelDe: "Rauchfangkehrer", labelEn: "Chimney sweep" },
    ],
  },
  {
    id: "fahrzeuge-technik",
    labelDe: "Fahrzeuge & Technik",
    labelEn: "Vehicles & technology",
    items: [
      { value: "KFZ-Technik", labelDe: "KFZ-Technik", labelEn: "Automotive technology" },
      { value: "Karosseriebau", labelDe: "Karosseriebau", labelEn: "Bodywork" },
      { value: "Vulkaniseur", labelDe: "Vulkaniseur", labelEn: "Tyre service" },
      { value: "Mechatronik", labelDe: "Mechatronik", labelEn: "Mechatronics" },
      {
        value: "Land- und Baumaschinentechnik",
        labelDe: "Land- und Baumaschinentechnik",
        labelEn: "Agricultural & construction machinery",
      },
    ],
  },
  {
    id: "gesundheit-koerper",
    labelDe: "Gesundheit & Körper",
    labelEn: "Health & body",
    items: [
      { value: "Augenoptik", labelDe: "Augenoptik", labelEn: "Optician" },
      { value: "Hörgeräteakustik", labelDe: "Hörgeräteakustik", labelEn: "Hearing aids acoustics" },
      { value: "Orthopädietechnik", labelDe: "Orthopädietechnik", labelEn: "Orthopaedic technology" },
      { value: "Drogisten", labelDe: "Drogisten", labelEn: "Drugstore / cosmetics" },
      { value: "Massage", labelDe: "Massage", labelEn: "Massage" },
      { value: "Kosmetik", labelDe: "Kosmetik", labelEn: "Cosmetics" },
      { value: "Fußpflege", labelDe: "Fußpflege", labelEn: "Foot care" },
      { value: "Zahntechnik", labelDe: "Zahntechnik", labelEn: "Dental technology" },
    ],
  },
  {
    id: "lebensmittel-gastronomie",
    labelDe: "Lebensmittel & Gastronomie",
    labelEn: "Food & gastronomy",
    items: [
      { value: "Bäcker", labelDe: "Bäcker", labelEn: "Baker" },
      { value: "Fleischer", labelDe: "Fleischer", labelEn: "Butcher" },
      { value: "Konditor", labelDe: "Konditor", labelEn: "Confectioner" },
      { value: "Gastgewerbe", labelDe: "Gastgewerbe", labelEn: "Hospitality" },
      { value: "Lebensmittelgewerbe", labelDe: "Lebensmittelgewerbe", labelEn: "Food retail / production" },
    ],
  },
  {
    id: "immobilien-finanzen",
    labelDe: "Immobilien & Finanzen",
    labelEn: "Real estate & finance",
    items: [
      { value: "Immobilienmakler", labelDe: "Immobilienmakler", labelEn: "Real estate agent" },
      { value: "Immobilienverwalter", labelDe: "Immobilienverwalter", labelEn: "Property manager" },
      { value: "Bauträger", labelDe: "Bauträger", labelEn: "Property developer" },
      { value: "Versicherungsvermittlung", labelDe: "Versicherungsvermittlung", labelEn: "Insurance broker" },
      { value: "Vermögensberatung", labelDe: "Vermögensberatung", labelEn: "Wealth advisory" },
      { value: "Inkassoinstitute", labelDe: "Inkassoinstitute", labelEn: "Debt collection" },
      { value: "Unternehmensberatung", labelDe: "Unternehmensberatung", labelEn: "Business consulting" },
    ],
  },
  {
    id: "transport-verkehr",
    labelDe: "Transport & Verkehr",
    labelEn: "Transport & traffic",
    items: [
      { value: "Taxi", labelDe: "Taxi", labelEn: "Taxi" },
      { value: "Mietwagengewerbe", labelDe: "Mietwagengewerbe", labelEn: "Car rental" },
      { value: "Güterbeförderung", labelDe: "Güterbeförderung", labelEn: "Freight transport" },
      { value: "Spedition", labelDe: "Spedition", labelEn: "Forwarding / logistics" },
      { value: "Personenbeförderung", labelDe: "Personenbeförderung", labelEn: "Passenger transport" },
    ],
  },
  {
    id: "sicherheit-bewachung",
    labelDe: "Sicherheit & Bewachung",
    labelEn: "Security & surveillance",
    items: [
      { value: "Berufsdetektive", labelDe: "Berufsdetektive", labelEn: "Private detectives" },
      { value: "Bewachungsgewerbe", labelDe: "Bewachungsgewerbe", labelEn: "Security services" },
      { value: "Alarmanlagen", labelDe: "Alarmanlagen", labelEn: "Alarm systems" },
      { value: "Waffenhandel", labelDe: "Waffenhandel", labelEn: "Arms trade" },
    ],
  },
  {
    id: "medien-kommunikation",
    labelDe: "Medien & Kommunikation",
    labelEn: "Media & communication",
    items: [
      { value: "Drucker", labelDe: "Drucker", labelEn: "Printer" },
      { value: "Fotograf", labelDe: "Fotograf", labelEn: "Photographer" },
      { value: "Buchbinder", labelDe: "Buchbinder", labelEn: "Bookbinder" },
    ],
  },
  {
    id: "sonstige",
    labelDe: "Sonstige Konzessionen",
    labelEn: "Other licenses",
    items: [
      { value: "Bestattung", labelDe: "Bestattung", labelEn: "Funeral services" },
      { value: "Arbeitsvermittlung", labelDe: "Arbeitsvermittlung", labelEn: "Employment agency" },
      { value: "Pyrotechnikunternehmen", labelDe: "Pyrotechnikunternehmen", labelEn: "Pyrotechnics" },
      {
        value: "Überlassung von Arbeitskräften",
        labelDe: "Überlassung von Arbeitskräften",
        labelEn: "Labour leasing",
      },
      { value: "Chemische Laboratorien", labelDe: "Chemische Laboratorien", labelEn: "Chemical laboratories" },
    ],
  },
];

export const ALL_TRADE_CATEGORY_VALUES = TRADE_CATEGORY_GROUPS.flatMap((g) =>
  g.items.map((i) => i.value)
) as readonly string[];

const VALUE_SET = new Set(ALL_TRADE_CATEGORY_VALUES);

export function isValidTradeCategory(value: string): boolean {
  return VALUE_SET.has(value.trim());
}

export function tradeCategoryItemByValue(value: string): TradeCategoryItem | undefined {
  const v = value.trim();
  for (const g of TRADE_CATEGORY_GROUPS) {
    const hit = g.items.find((i) => i.value === v);
    if (hit) return hit;
  }
  return undefined;
}

export function tradeCategoryLabel(value: string, locale: "de" | "en"): string {
  const item = tradeCategoryItemByValue(value);
  if (item) return locale === "de" ? item.labelDe : item.labelEn;
  return value.trim();
}

export function tradeCategoryGroupForValue(value: string): TradeCategoryGroup | undefined {
  const v = value.trim();
  return TRADE_CATEGORY_GROUPS.find((g) => g.items.some((i) => i.value === v));
}
