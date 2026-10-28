'use strict';

const env = process.env;
const split = (v) => String(v || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: Number(env.PORT || 3000),
  production: env.NODE_ENV === 'production',
  databaseUrl: env.DATABASE_URL || '',
  databaseSsl: env.DATABASE_SSL === 'true',
  sessionSecret: env.SESSION_SECRET || '',
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || '',
  refreshHours: Number(env.REFRESH_HOURS || 6),
  staleHours: Number(env.STALE_HOURS || 48),
  disableFeeds: env.DISABLE_FEEDS === 'true',
  // Each feed lists candidate URLs, tried in order until one downloads and parses.
  feeds: {
    un: split(env.UN_URLS || 'https://scsanctions.un.org/resources/xml/en/consolidated.xml'),
    ofac: split(
      env.OFAC_URLS ||
        'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML https://www.treasury.gov/ofac/downloads/sdn.xml'
    ),
    eu: split(
      env.EU_URLS ||
        'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw'
    ),
    canada: split(env.CANADA_URLS || 'https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml'),
    swiss: split(env.SWISS_URLS || 'https://www.sesam.search.admin.ch/sesam-search-web/pages/downloadXmlGesamtliste.xhtml?lang=en&action=downloadXmlGesamtlisteAction'),
    australia: split(env.AUSTRALIA_URLS || 'https://www.dfat.gov.au/sites/default/files/Australian_Sanctions_Consolidated_List.xlsx https://www.dfat.gov.au/sites/default/files/regulation8_consolidated.xlsx'),
    uk: split(env.UK_URLS || 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml'),
  },
};
