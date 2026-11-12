// Mappings from OpenMapTiles class names to DMAP codes (see format/FORMAT.md).
// Our own tables. Unknown classes map to nothing, so they are skipped or given a default.

// Routable road classes (edge roadClass).
export const ROAD_CLASS = {
  motorway: 1,
  trunk: 2,
  primary: 3,
  secondary: 4,
  tertiary: 5,
  minor: 6,
  service: 7,
  track: 8,
};

export const LINE_KIND = {
  rail: 1,
  transit: 2,
  ferry: 3,
  river: 4,
  canal: 5,
  stream: 6,
  footpath: 7,
  pier: 9,
  boundary: 11,
  waterway: { river: 4, canal: 5, stream: 6, drain: 6, ditch: 6 },
  boundaryKind: 11,
};

// Line kinds for transportation features that are not routable roads.
export function roadLineKind(cls, subclass) {
  if (cls === "rail") return 1;
  if (cls === "transit") return 2;
  if (cls === "ferry") return 3;
  if (cls === "pier") return 9;
  if (cls === "path") return 7;
  return null;
}

// Area kinds (polygon kind). Returns null when the feature is not drawn.
export const POLYGON_KIND = {
  area(layer, tags) {
    const c = tags.class;
    const s = tags.subclass;
    switch (layer) {
      case "water":
        return 1;
      case "building":
        return 2;
      case "park":
        return 3;
      case "landcover":
        if (c === "wood") return 4;
        if (c === "grass") return s === "park" ? 3 : 5;
        if (c === "farmland") return 6;
        if (c === "sand") return 7;
        if (c === "wetland") return 8;
        if (c === "rock") return 15;
        return null;
      case "landuse":
        if (c === "residential") return 9;
        if (c === "industrial") return 10;
        if (c === "commercial" || c === "retail") return 11;
        if (["school", "college", "university", "kindergarten", "library", "hospital", "education", "healthcare"].includes(c)) return 12;
        if (["pitch", "playground", "stadium", "recreation_ground", "zoo", "theme_park", "golf_course"].includes(c)) return 13;
        if (c === "cemetery") return 14;
        if (c === "quarry") return 15;
        return null;
      case "transportation":
        return c === "pier" ? 16 : null;
      default:
        return null;
    }
  },
};

// Place label categories.
export const PLACE_CATEGORY = {
  city: 1,
  town: 2,
  village: 3,
  hamlet: 4,
  suburb: 5,
  quarter: 6,
  neighbourhood: 7,
  isolated_dwelling: 8,
  island: 9,
};

// Point-of-interest categories, by OpenMapTiles poi class.
export const POI_CATEGORY = {
  other: 11,
  restaurant: 1, cafe: 1, fast_food: 1, beer: 1, bar: 1, ice_cream: 1,
  shop: 2, clothing_store: 2, grocery: 2, hairdresser: 2, convenience: 2, supermarket: 2,
  bus: 3, rail: 3, ferry_terminal: 3, airport: 3, taxi: 3, bicycle_rental: 3,
  hospital: 4, pharmacy: 4, dentist: 4, doctors: 4, clinic: 4,
  school: 5, college: 5, university: 5, kindergarten: 5, library: 5,
  parking: 6, fuel: 6, charging_station: 6,
  lodging: 7,
  place_of_worship: 8,
  park: 9, playground: 9, pitch: 9, swimming_pool: 9, stadium: 9, art_gallery: 9, cinema: 9, theatre: 9, museum: 9, zoo: 9, garden: 9,
  town_hall: 10, police: 10, post: 10, bank: 10, atm: 10, fire_station: 10, community_centre: 10, office: 10, telephone: 10, toilets: 10,
};

// Label kinds.
export const LABEL_KIND = {
  place: 1,
  road: 2,
  water: 3,
  park: 4,
  poi: 5,
};
