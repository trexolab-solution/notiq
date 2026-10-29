/**
 * Compact public-suffix table (a curated subset of https://publicsuffix.org/list/).
 *
 * Every single-label TLD is implicitly a public suffix (the PSL's default `*` rule),
 * so only MULTI-label suffixes are listed here.
 *
 * Format: `SECOND_LEVEL[tld]` is a space-separated list of second-level labels that,
 * joined with the TLD, are public suffixes (`uk: "co ac gov"` → `co.uk`, `ac.uk`, `gov.uk`).
 * `EXTRA` holds deeper suffixes and common private-section suffixes (hosting platforms
 * where every customer gets a subdomain). `WILDCARD` lists PSL `*.<x>` rules and
 * `EXCEPTION` lists PSL `!<x>` rules.
 *
 * How to refresh:
 *   1. Download https://publicsuffix.org/list/public_suffix_list.dat
 *   2. From the ICANN section take every rule with exactly two labels and group it by TLD
 *      into SECOND_LEVEL (keep the well-known ccTLDs; obscure geographic rules such as
 *      `<city>.jp` may be skipped — the matcher only needs suffixes users actually log in under).
 *   3. Copy rules with three or more labels you care about, and popular PRIVATE-section
 *      rules (github.io, vercel.app, …), into EXTRA.
 *   4. Copy `*.` rules into WILDCARD (without the `*.`) and `!` rules into EXCEPTION.
 *   5. Run `npx vitest run src/lib/publicSuffix.test.ts`.
 */

export const SECOND_LEVEL: Record<string, string> = {
  ac: "com edu gov net mil org",
  ae: "co net org sch ac gov mil",
  af: "gov com org net edu",
  ag: "com org net co nom",
  al: "com edu gov mil net org",
  am: "co com commune net org",
  ao: "ed gv og co pb it",
  ar: "com edu gob gov int mil net org tur bet coop musica",
  at: "ac co gv or sth",
  au: "com net org edu gov asn id csiro act nsw nt qld sa tas vic wa",
  az: "com net int gov org edu info pp mil name pro biz",
  ba: "com edu gov mil net org",
  bb: "biz co com edu gov info net org store tv",
  bd: "com edu gov net org ac mil",
  bh: "com edu net org gov",
  bn: "com edu gov net org",
  bo: "com edu gob int org net mil tv web",
  br: "com net org gov edu mil art adv blog eco eng etc far fm fot inf jus leg med mus not odo psi rec slg srv tmp tur tv vet wiki ind ong",
  bs: "com net org edu gov",
  bt: "com edu gov net org",
  bw: "co org",
  by: "gov mil com of",
  bz: "com net org edu gov",
  ca: "ab bc mb nb nf nl ns nt nu on pe qc sk yk gc",
  cn: "ac com edu gov net org mil ah bj cq fj gd gs gz gx ha hb he hi hl hn jl js jx ln nm nx qh sc sd sh sn sx tj xj xz yn zj hk mo tw",
  co: "arts com edu firm gov info int mil net nom org rec web",
  cr: "ac co ed fi go or sa",
  cu: "com edu org net gov inf",
  cy: "ac biz com ekloges gov ltd mil net org press pro tm",
  do: "art com edu gob gov mil net org sld web",
  dz: "art asso com edu gov org net pol soc tm",
  ec: "com info net fin k12 med pro org edu gov gob mil",
  ee: "edu gov riik lib med com pri aip org fie",
  eg: "com edu eun gov mil name net org sci",
  es: "com nom org gob edu",
  et: "com gov org edu biz name info net",
  fj: "ac biz com gov info mil name net org pro",
  fr: "asso com gouv nom prd tm",
  ge: "com edu gov org mil net pvt",
  gh: "com edu gov org mil",
  gi: "com ltd gov mod edu org",
  gr: "com edu net org gov",
  gt: "com edu gob ind mil net org",
  gy: "co com edu gov net org",
  hk: "com edu gov idv net org",
  hn: "com edu org net mil gob",
  hr: "iz from name com",
  ht: "com shop firm info adult net pro org med art coop pol asso edu rel gouv perso",
  hu: "co info org priv sport tm agrar bolt casino city erotica film forum games hotel ingatlan jogasz konyvelo lakas media news reklam sex shop suli szex tozsde utazas video",
  id: "ac biz co desa go mil my net or ponpes sch web",
  ie: "gov",
  il: "ac co gov idf k12 muni net org",
  in: "co firm net org gen ind nic ac edu res gov mil biz info",
  iq: "gov edu mil com org net",
  ir: "ac co gov id net org sch",
  it: "gov edu",
  je: "co net org",
  jm: "com net org edu gov mil",
  jo: "com org net edu sch gov mil name",
  jp: "ac ad co ed go gr lg ne or",
  ke: "ac co go info me mobi ne or sc",
  kg: "org net com edu gov mil",
  kh: "com edu gov mil net org per",
  kr: "ac co es go hs kg mil ms ne or pe re sc",
  kw: "com edu emb gov ind net org",
  kz: "org edu net gov mil com",
  lb: "com edu gov net org",
  lk: "gov sch net int com org edu ngo soc web ltd assn grp hotel ac",
  lr: "com edu gov org net",
  ls: "ac biz co edu gov info net org sc",
  lv: "com edu gov org mil id net asn conf",
  ly: "com net gov plc edu sch med org id",
  ma: "co net gov org ac press",
  mk: "com org net edu gov inf name",
  mm: "com edu gov net org",
  mn: "gov edu org",
  mo: "com net org edu gov",
  mt: "com edu net org",
  mu: "com net org gov ac co or",
  mv: "aero biz com coop edu gov info int mil museum name net org pro",
  mw: "ac biz co com coop edu gov int museum net org",
  mx: "com org gob edu net",
  my: "biz com edu gov mil name net org",
  mz: "ac adv co edu gov mil net org",
  na: "info pro name school or dr us mx ca in cc tv ws mobi co com org",
  ng: "com edu gov i mil mobi name net org sch",
  ni: "ac biz co com edu gob in info int mil net nom org web",
  np: "com edu gov org mil net",
  nz: "ac co cri geek gen govt health iwi kiwi maori mil net org parliament school",
  om: "co com edu gov med museum net org pro",
  pa: "ac gob com org sld edu net ing abo med nom",
  pe: "edu gob nom mil org com net",
  pg: "com net org gov mil ac",
  ph: "com net org gov edu ngo mil i",
  pk: "com net edu org fam biz web gov gob gok gon gop gos info",
  pl: "com net org aid agro atm auto biz edu gmina gsm info mail miasta media mil nieruchomosci nom pc powiat priv realestate rel sex shop sklep sos szkola targi tm tourism travel turystyka gov",
  pr: "com net org gov edu isla pro biz info name est prof ac",
  ps: "edu gov sec plo com org net",
  pt: "net gov org edu int publ com nome",
  py: "com coop edu gov mil net org",
  qa: "com edu gov mil name net org sch",
  ro: "arts com firm info nom nt org rec store tm www",
  rs: "ac co edu gov in org",
  ru: "ac edu gov int mil test",
  rw: "ac co coop gov mil net org",
  sa: "com net org gov med pub edu sch",
  sb: "com edu gov net org",
  sc: "com gov net org edu",
  sd: "com net org edu med tv gov info",
  sg: "com net org gov edu per",
  sl: "com net edu gov org",
  sn: "art com edu gouv org perso univ",
  sv: "com edu gob org red",
  sy: "edu gov net mil com org",
  th: "ac co go in mi net or",
  tj: "ac biz co com edu go gov int mil name net nic org test web",
  tn: "com ens fin gov ind info intl mincom nat net org perso tourism",
  tr: "av bbs bel biz com dr edu gen gov info mil k12 kep name net org pol tel tsk tv web nc",
  tt: "co com org net biz info pro int coop jobs mobi travel museum aero name gov edu",
  tw: "edu gov mil com net org idv game ebiz club",
  tz: "ac co go hotel info me mil mobi ne or sc tv",
  ua: "com edu gov in net org kiev kyiv lviv odessa kharkov dnepropetrovsk",
  ug: "co or ac sc go ne com org",
  uk: "ac co gov ltd me net nhs org plc police sch",
  us: "dni fed isa kids nsn ak al ar as az ca co ct dc de fl ga gu hi ia id il in ks ky la ma md me mi mn mo ms mt nc nd ne nh nj nm nv ny oh ok or pa pr ri sc sd tn tx ut vi vt va wa wi wv wy",
  uy: "com edu gub mil net org",
  uz: "co com net org",
  ve: "arts bib co com e12 edu firm gob gov info int mil net nom org rar rec store tec web",
  vn: "com net org edu gov int ac biz info name pro health",
  ws: "com net org gov edu",
  za: "ac agric alt co edu gov grondar law mil net ngo nic nis nom org school tm web",
  zm: "ac biz co com edu gov info mil net org sch",
  zw: "ac co gov mil org",
};

/** Deeper ICANN suffixes and popular private-section (hosting platform) suffixes. */
export const EXTRA: string[] = [
  // ICANN, three labels
  "nsw.edu.au", "vic.edu.au", "qld.edu.au", "gov.au",
  "k12.ca.us", "k12.ny.us", "k12.tx.us",
  "blogspot.co.uk",
  // Private section (every customer gets a subdomain)
  "github.io", "githubusercontent.com", "gitlab.io", "bitbucket.io",
  "herokuapp.com", "herokussl.com", "vercel.app", "now.sh", "netlify.app", "netlify.com",
  "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "appspot.com",
  "blogspot.com", "wordpress.com", "tumblr.com", "azurewebsites.net", "azurestaticapps.net",
  "cloudapp.net", "cloudfront.net", "s3.amazonaws.com", "elasticbeanstalk.com",
  "onrender.com", "fly.dev", "glitch.me", "repl.co", "replit.app", "surge.sh",
  "ngrok.io", "ngrok-free.app", "duckdns.org", "no-ip.org", "dyndns.org",
  "myshopify.com", "wixsite.com", "squarespace.com", "webflow.io", "readthedocs.io",
];

/** PSL `*.<x>` rules: every label directly under these is itself a public suffix. */
export const WILDCARD: string[] = [
  "bd", "ck", "er", "fk", "jm", "kh", "mm", "np", "pg", "kawasaki.jp", "kitakyushu.jp", "kobe.jp",
  "nagoya.jp", "sapporo.jp", "sendai.jp", "yokohama.jp", "compute.amazonaws.com",
];

/** PSL `!<x>` rules: exceptions to a wildcard (these ARE registrable domains). */
export const EXCEPTION: string[] = [
  "www.ck", "city.kawasaki.jp", "city.kitakyushu.jp", "city.kobe.jp", "city.nagoya.jp",
  "city.sapporo.jp", "city.sendai.jp", "city.yokohama.jp",
];
