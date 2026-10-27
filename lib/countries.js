'use strict';
// Country normalisation to ISO 3166 alpha-2. Accepts alpha-2, alpha-3 and English names as used
// by the UN, OFAC, EU and UK lists.

const ISO3_RAW = `AFG AF ALA AX ALB AL DZA DZ ASM AS AND AD AGO AO AIA AI ATA AQ ATG AG ARG AR ARM AM ABW AW AUS AU AUT AT AZE AZ
BHS BS BHR BH BGD BD BRB BB BLR BY BEL BE BLZ BZ BEN BJ BMU BM BTN BT BOL BO BES BQ BIH BA BWA BW BVT BV BRA BR IOT IO BRN BN
BGR BG BFA BF BDI BI CPV CV KHM KH CMR CM CAN CA CYM KY CAF CF TCD TD CHL CL CHN CN CXR CX CCK CC COL CO COM KM COG CG COD CD
COK CK CRI CR CIV CI HRV HR CUB CU CUW CW CYP CY CZE CZ DNK DK DJI DJ DMA DM DOM DO ECU EC EGY EG SLV SV GNQ GQ ERI ER EST EE
SWZ SZ ETH ET FLK FK FRO FO FJI FJ FIN FI FRA FR GUF GF PYF PF ATF TF GAB GA GMB GM GEO GE DEU DE GHA GH GIB GI GRC GR GRL GL
GRD GD GLP GP GUM GU GTM GT GGY GG GIN GN GNB GW GUY GY HTI HT HMD HM VAT VA HND HN HKG HK HUN HU ISL IS IND IN IDN ID IRN IR
IRQ IQ IRL IE IMN IM ISR IL ITA IT JAM JM JPN JP JEY JE JOR JO KAZ KZ KEN KE KIR KI PRK KP KOR KR KWT KW KGZ KG LAO LA LVA LV
LBN LB LSO LS LBR LR LBY LY LIE LI LTU LT LUX LU MAC MO MDG MG MWI MW MYS MY MDV MV MLI ML MLT MT MHL MH MTQ MQ MRT MR MUS MU
MYT YT MEX MX FSM FM MDA MD MCO MC MNG MN MNE ME MSR MS MAR MA MOZ MZ MMR MM NAM NA NRU NR NPL NP NLD NL NCL NC NZL NZ NIC NI
NER NE NGA NG NIU NU NFK NF MKD MK MNP MP NOR NO OMN OM PAK PK PLW PW PSE PS PAN PA PNG PG PRY PY PER PE PHL PH PCN PN POL PL
PRT PT PRI PR QAT QA REU RE ROU RO RUS RU RWA RW BLM BL SHN SH KNA KN LCA LC MAF MF SPM PM VCT VC WSM WS SMR SM STP ST SAU SA
SEN SN SRB RS SYC SC SLE SL SGP SG SXM SX SVK SK SVN SI SLB SB SOM SO ZAF ZA SGS GS SSD SS ESP ES LKA LK SDN SD SUR SR SJM SJ
SWE SE CHE CH SYR SY TWN TW TJK TJ TZA TZ THA TH TLS TL TGO TG TKL TK TON TO TTO TT TUN TN TUR TR TKM TM TCA TC TUV TV UGA UG
UKR UA ARE AE GBR GB USA US UMI UM URY UY UZB UZ VUT VU VEN VE VNM VN VGB VG VIR VI WLF WF ESH EH YEM YE ZMB ZM ZWE ZW XKX XK`;

const ISO3 = new Map();
{
  const p = ISO3_RAW.split(/\s+/);
  for (let i = 0; i + 1 < p.length; i += 2) ISO3.set(p[i], p[i + 1]);
}

function normName(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['\u2019`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXCLUDE = new Set(['ZZ', 'EU', 'UN', 'EZ', 'QO', 'XA', 'XB', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ', 'UK', 'FX', 'SU', 'YU', 'ZR', 'TP', 'BU', 'DD', 'NT', 'CS', 'AN', 'SF', 'VD', 'YD']);
const dn = new Intl.DisplayNames(['en'], { type: 'region' });
const ISO2 = new Map();
const NAME = new Map();
for (let a = 65; a <= 90; a++) {
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (EXCLUDE.has(code)) continue;
    let n;
    try {
      n = dn.of(code);
    } catch (e) {
      continue;
    }
    if (!n || n === code) continue;
    ISO2.set(code, n);
    NAME.set(normName(n), code);
  }
}

const ALIAS = new Map(Object.entries({
  'iran islamic republic of': 'IR', iran: 'IR', 'russian federation': 'RU', russia: 'RU',
  'syrian arab republic': 'SY', syria: 'SY', 'korea north': 'KP', 'north korea': 'KP',
  'democratic peoples republic of korea': 'KP', 'korea democratic peoples republic of': 'KP', dprk: 'KP',
  'korea south': 'KR', 'south korea': 'KR', 'republic of korea': 'KR', 'korea republic of': 'KR',
  burma: 'MM', myanmar: 'MM', 'ivory coast': 'CI', 'cote d ivoire': 'CI', 'cote divoire': 'CI',
  'congo democratic republic of the': 'CD', 'democratic republic of the congo': 'CD', 'congo kinshasa': 'CD',
  'dr congo': 'CD', drc: 'CD', 'congo republic of the': 'CG', 'republic of the congo': 'CG', congo: 'CG',
  'congo brazzaville': 'CG', laos: 'LA', 'lao peoples democratic republic': 'LA', 'viet nam': 'VN', vietnam: 'VN',
  venezuela: 'VE', bolivia: 'BO', 'tanzania united republic of': 'TZ', tanzania: 'TZ',
  palestine: 'PS', 'state of palestine': 'PS', 'palestinian territories': 'PS', 'west bank': 'PS', gaza: 'PS',
  'gaza strip': 'PS', uae: 'AE', 'u a e': 'AE', 'united arab emirates': 'AE', 'united states': 'US',
  'united states of america': 'US', usa: 'US', 'u s': 'US', 'u s a': 'US', uk: 'GB', 'u k': 'GB',
  'united kingdom': 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  'czech republic': 'CZ', czechia: 'CZ', turkey: 'TR', turkiye: 'TR', macau: 'MO', 'macao sar china': 'MO',
  'hong kong': 'HK', 'hong kong sar china': 'HK', taiwan: 'TW', 'cape verde': 'CV', swaziland: 'SZ',
  eswatini: 'SZ', macedonia: 'MK', 'north macedonia': 'MK', moldova: 'MD', brunei: 'BN',
  'brunei darussalam': 'BN', 'east timor': 'TL', 'timor leste': 'TL', 'kyrgyz republic': 'KG', kyrgyzstan: 'KG',
  'holy see': 'VA', vatican: 'VA', 'vatican city': 'VA', micronesia: 'FM', 'falkland islands': 'FK',
  'falkland islands malvinas': 'FK', 'british virgin islands': 'VG', 'virgin islands british': 'VG',
  kosovo: 'XK', 'virgin islands uk': 'VG', 'virgin islands us': 'VI', 'us virgin islands': 'VI', 'saint kitts and nevis': 'KN', 'st kitts and nevis': 'KN', 'saint lucia': 'LC', 'st lucia': 'LC',
  'saint vincent and the grenadines': 'VC', 'st vincent and the grenadines': 'VC', 'sao tome and principe': 'ST',
  'trinidad and tobago': 'TT', 'antigua and barbuda': 'AG', 'bosnia and herzegovina': 'BA', 'bosnia herzegovina': 'BA',
  'the gambia': 'GM', gambia: 'GM', 'the bahamas': 'BS', bahamas: 'BS', 'libyan arab jamahiriya': 'LY', libya: 'LY',
  'republic of ireland': 'IE', 'the netherlands': 'NL', holland: 'NL', 'south sudan': 'SS', 'western sahara': 'EH',
  'mainland china': 'CN', 'peoples republic of china': 'CN', 'china': 'CN', 'netherlands antilles': 'CW',
}));

function toIso2(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s) && ISO2.has(s.toUpperCase())) return s.toUpperCase();
  if (/^[A-Za-z]{3}$/.test(s) && ISO3.has(s.toUpperCase())) return ISO3.get(s.toUpperCase());
  const n = normName(s);
  const flat = normName(s.replace(/[()]/g, ' '));
  return NAME.get(n) || ALIAS.get(n) || NAME.get(flat) || ALIAS.get(flat) || null;
}

function toIso2List(input) {
  const arr = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[;,|\/]/);
  const out = [];
  for (const x of arr) {
    const c = toIso2(x);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function countryName(iso2) {
  return ISO2.get(iso2) || iso2;
}

function allCountries() {
  return [...ISO2.entries()].map(([iso2, name]) => ({ iso2, name })).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { toIso2, toIso2List, countryName, allCountries, ISO3 };
