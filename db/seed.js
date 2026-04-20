// Seed reference data + sample users + sample master records
const db = require('./connection');

const seed = db.transaction(() => {
  // -------- USERS --------
  const users = [
    // Vendor / legacy roles
    ['requestor@demo.com', 'Alex Requestor', 'BU_REQUESTOR', 'Operations', 'Acme Corp', 'NORTH_AMERICA', 'US'],
    ['sc.manager@demo.com', 'Sam Chen', 'SUPPLY_CHAIN', 'Procurement', 'Acme Corp', 'NORTH_AMERICA', 'US'],
    ['legal@demo.com', 'Lin Counsel', 'LEGAL', 'Legal', 'Acme Corp', 'GLOBAL', null],
    ['admin@demo.com', 'Morgan Admin', 'MASTER_ADMIN', 'MDM Operations', 'Acme Corp', 'GLOBAL', null],
    ['finance@demo.com', 'Fin Reeves', 'FINANCE', 'Finance', 'Acme Corp', 'NORTH_AMERICA', 'US'],
    ['sales@demo.com', 'Sal Torres', 'SALES', 'Sales', 'Acme Corp', 'NORTH_AMERICA', 'US'],
    ['regional@demo.com', 'Reg Patel', 'REGIONAL', 'Regional Mgmt', 'Acme Corp', 'EMEA', 'UK'],
    ['product@demo.com', 'Pat Lee', 'PRODUCT_OWNER', 'Engineering', 'Acme Corp', 'NORTH_AMERICA', 'US'],
    ['supplier@example.com', 'Sky Vendor Inc', 'SUPPLIER', null, 'Sky Vendor Inc', null, null],
    ['customer@example.com', 'Delta Buyers Ltd', 'CUSTOMER', null, 'Delta Buyers Ltd', null, null],
    // Customer-master roles (per updated BRD)
    ['cs@demo.com',        'Casey Service',   'CUSTOMER_SERVICE', 'Customer Service', 'Acme Corp', 'NORTH_AMERICA', 'US'],
    ['mdm1@demo.com',      'Mo Data',         'MDM_TEAM',         'Master Data',      'Acme Corp', 'GLOBAL', null],
    ['mdm2@demo.com',      'Devi Master',     'MDM_TEAM',         'Master Data',      'Acme Corp', 'GLOBAL', null],
    ['quality@demo.com',   'Quinn Regulatory','QUALITY_REG',      'Quality',          'Acme Corp', 'GLOBAL', null],
    ['corpsec@demo.com',   'Carla Security',  'CORP_SECURITY',    'Corporate Security','Acme Corp','LATAM',   'MX'],
    ['credit@demo.com',    'Cred Manager',    'CREDIT_MGMT',      'Credit',           'Acme Corp', 'GLOBAL', null],
    ['finmgmt@demo.com',   'Fin Manager',     'FIN_MGMT',         'Finance',          'Acme Corp', 'GLOBAL', null],
    ['supervisor@demo.com','Sue Supervisor',  'SUPERVISOR',       'Master Data Supervisor','Acme Corp','GLOBAL', null],
  ];
  const ins = db.prepare(`INSERT OR IGNORE INTO users (email,name,role,department,legal_entity,region,sub_region) VALUES (?,?,?,?,?,?,?)`);
  for (const u of users) ins.run(...u);

  // -------- REFERENCE DATA --------
  // NOTE: categories are UPPERCASE to match view template keys (ref.COUNTRY, ref.STATE etc.)
  const refIns = db.prepare(`INSERT OR IGNORE INTO reference_data (category,code,label,parent,metadata) VALUES (?,?,?,?,?)`);

  const latam = ['AR','BO','BR','CL','CO','CR','CU','DO','EC','SV','GT','HT','HN','JM','MX','NI','PA','PY','PE','PR','TT','UY','VE'];
  const eu    = ['AT','BE','CZ','DK','FI','FR','DE','GR','HU','IE','IT','LU','NL','NO','PL','PT','RO','ES','SE','CH','GB'];

  const countries = [
    ['US','United States'],['CA','Canada'],['MX','Mexico'],['GB','United Kingdom'],
    ['DE','Germany'],['FR','France'],['ES','Spain'],['IT','Italy'],['NL','Netherlands'],
    ['IN','India'],['CN','China'],['JP','Japan'],['KR','South Korea'],['BR','Brazil'],
    ['AR','Argentina'],['CO','Colombia'],['AU','Australia'],['SG','Singapore'],
    ['ZA','South Africa'],['AE','United Arab Emirates'],['CH','Switzerland'],
    ['SE','Sweden'],['NO','Norway'],['PL','Poland'],['TR','Turkey'],
    ['AT','Austria'],['BE','Belgium'],['CZ','Czech Republic'],['DK','Denmark'],['FI','Finland'],
    ['GR','Greece'],['HU','Hungary'],['IE','Ireland'],['LU','Luxembourg'],['PT','Portugal'],
    ['RO','Romania'],['BO','Bolivia'],['CL','Chile'],['CR','Costa Rica'],['CU','Cuba'],['DO','Dominican Republic'],
    ['EC','Ecuador'],['SV','El Salvador'],['GT','Guatemala'],['HT','Haiti'],['HN','Honduras'],
    ['JM','Jamaica'],['NI','Nicaragua'],['PA','Panama'],['PY','Paraguay'],['PE','Peru'],
    ['PR','Puerto Rico'],['TT','Trinidad and Tobago'],['UY','Uruguay'],['VE','Venezuela'],
  ];
  countries.forEach(([c,l]) => {
    const meta = JSON.stringify({ region: latam.includes(c) ? 'LATAM' : eu.includes(c) ? 'EU' : 'OTHER' });
    refIns.run('COUNTRY', c, l, null, meta);
  });

  const states = [
    ['CA','California','US'],['NY','New York','US'],['TX','Texas','US'],['FL','Florida','US'],['IL','Illinois','US'],
    ['WA','Washington','US'],['MA','Massachusetts','US'],['GA','Georgia','US'],['NC','North Carolina','US'],['PA','Pennsylvania','US'],
    ['ON','Ontario','CA'],['QC','Quebec','CA'],['BC','British Columbia','CA'],['AB','Alberta','CA'],
    ['MH','Maharashtra','IN'],['KA','Karnataka','IN'],['DL','Delhi','IN'],['TN','Tamil Nadu','IN'],
  ];
  states.forEach(([c,l,p]) => refIns.run('STATE', c, l, p, null));

  const currencies = [['USD','US Dollar'],['EUR','Euro'],['GBP','British Pound'],['INR','Indian Rupee'],['CNY','Chinese Yuan'],['JPY','Japanese Yen'],['CAD','Canadian Dollar'],['MXN','Mexican Peso'],['BRL','Brazilian Real'],['AUD','Australian Dollar']];
  currencies.forEach(([c,l]) => refIns.run('CURRENCY', c, l, null, null));

  const terms = [['NET30','Net 30'],['NET45','Net 45'],['NET60','Net 60'],['NET90','Net 90'],['2_10_N30','2/10 Net 30'],['PROX9','Prox 9'],['IMMEDIATE','Immediate'],['COD','Cash on Delivery']];
  terms.forEach(([c,l]) => refIns.run('PAYMENT_TERM', c, l, null, null));

  const commodities = [
    ['CM001','IT Services & Software'],['CM002','Office Supplies'],['CM003','Raw Materials'],
    ['CM004','Manufactured Components'],['CM005','Professional Services'],['CM006','Logistics & Freight'],
    ['CM007','Facilities Management'],['CM008','Marketing & Media'],['CM009','Legal Services'],
    ['CM010','Capital Equipment'],['CM011','Chemicals'],['CM012','Packaging'],
  ];
  commodities.forEach(([c,l]) => refIns.run('COMMODITY_CODE', c, l, null, null));

  const cat1 = [['DIRECT','Direct Spend'],['INDIRECT','Indirect Spend'],['CAPEX','Capital Expenditure'],['SERVICES','Services']];
  cat1.forEach(([c,l]) => refIns.run('CATEGORY', c, l, null, null));

  const uoms = [['EA','Each'],['BX','Box'],['KG','Kilogram'],['LB','Pound'],['M','Meter'],['FT','Foot'],['L','Liter'],['GAL','Gallon'],['HR','Hour'],['DAY','Day']];
  uoms.forEach(([c,l]) => refIns.run('UOM', c, l, null, null));

  const incoterms = [['EXW','Ex Works'],['FCA','Free Carrier'],['FOB','Free On Board'],['CIF','Cost Insurance Freight'],['DDP','Delivered Duty Paid'],['DAP','Delivered at Place']];
  incoterms.forEach(([c,l]) => refIns.run('INCOTERM', c, l, null, null));

  const paymentInst = [['WIRE','Wire Transfer'],['ACH','ACH / EFT'],['CHECK','Check'],['CARD','P-Card'],['DD','Direct Debit'],['SEPA','SEPA Direct Debit'],['LSV','LSV (Switzerland)'],['LCR','LCR (France)']];
  paymentInst.forEach(([c,l]) => refIns.run('PAYMENT_INSTRUMENT', c, l, null, null));

  const supplierAttrs = [['WHQ','World HQ'],['CHQ','Country HQ'],['RHQ','Regional HQ'],['BU','Business Unit'],['IC','Intercompany'],['LOCAL','Local Vendor']];
  supplierAttrs.forEach(([c,l]) => refIns.run('SUPPLIER_ATTRIBUTE', c, l, null, null));

  const erpInstances = [['GLOBAL_JDE','Global JDE'],['SAP_ECC','SAP ECC'],['SAP_S4','SAP S/4 HANA'],['ORACLE_EBS','Oracle EBS'],['NETSUITE','NetSuite'],['DYNAMICS','MS Dynamics 365']];
  erpInstances.forEach(([c,l]) => refIns.run('ERP_INSTANCE', c, l, null, null));

  const productTypes = [['FINISHED','Finished Good'],['RAW','Raw Material'],['SEMI','Semi-Finished'],['SERVICE','Service'],['TRADING','Trading Good']];
  productTypes.forEach(([c,l]) => refIns.run('PRODUCT_TYPE', c, l, null, null));

  const materialGroups = [['MG001','Electronics'],['MG002','Mechanical Parts'],['MG003','Chemicals'],['MG004','Textiles'],['MG005','Packaging'],['MG006','Software Licenses']];
  materialGroups.forEach(([c,l]) => refIns.run('MATERIAL_GROUP', c, l, null, null));

  // Customer master specific
  const custTypes = [['SOLD_TO','Sold-to Party'],['SHIP_TO','Ship-to Party'],['BILL_TO','Bill-to Party'],['PAYER','Payer'],['END_TO_END','End-to-End (all 4 partner functions)']];
  custTypes.forEach(([c,l]) => refIns.run('CUSTOMER_TYPE', c, l, null, null));

  const partnerFns = [['SOLD_TO','Sold-To'],['SHIP_TO','Ship-To'],['BILL_TO','Bill-To'],['PAYER','Payer'],['END_TO_END','End-to-End']];
  partnerFns.forEach(([c,l]) => refIns.run('PARTNER_FUNCTION', c, l, null, null));

  const salesOrgs = [['NA01','North America Sales'],['EU01','Europe Sales'],['AP01','Asia Pacific Sales'],['LA01','Latin America Sales']];
  salesOrgs.forEach(([c,l]) => refIns.run('SALES_ORG', c, l, null, null));

  const distChannels = [['DIRECT','Direct'],['RESELLER','Reseller'],['DISTRIBUTOR','Distributor'],['OEM','OEM'],['RETAIL','Retail'],['ONLINE','Online']];
  distChannels.forEach(([c,l]) => refIns.run('DISTRIBUTION_CHANNEL', c, l, null, null));

  const custGroups = [['HOSP','Hospital / Healthcare'],['PHARM','Pharmacy'],['GOV','Government'],['DIST','Distributor'],['OEM','OEM / Manufacturer'],['RETAIL','Retail Chain'],['WHOLE','Wholesale'],['ED','Education']];
  custGroups.forEach(([c,l]) => refIns.run('CUSTOMER_GROUP', c, l, null, null));

  const markets = [['US','United States'],['CA','Canada'],['MX','Mexico'],['UK','United Kingdom'],['DE','Germany'],['FR','France'],['IT','Italy'],['ES','Spain'],['BR','Brazil'],['IN','India'],['JP','Japan'],['CN','China'],['AU','Australia']];
  markets.forEach(([c,l]) => refIns.run('MARKET', c, l, null, null));

  const priorities = [['REGULAR','Regular'],['HIGH_PENDING','High — Pending Orders'],['HIGH_RUSH','High — Rush Order Pending']];
  priorities.forEach(([c,l]) => refIns.run('PRIORITY', c, l, null, null));

  const changeTypes = [['NAME','Customer Name'],['ADDRESS','Customer Address'],['TAX_ID','Tax ID'],['PAYMENT_TERMS','Payment Terms / Credit Limit'],['OTHER','Other Information']];
  changeTypes.forEach(([c,l]) => refIns.run('CHANGE_TYPE', c, l, null, null));

  // Reject / Request-More-Info reason codes
  const rejectCodes = [
    ['QA_REJECT_UNSAT','QA REJECT — Unsatisfactory qualification documentation'],
    ['CF_REJECT_UNSAT','Credit/Finance REJECT — Unsatisfactory finance documentation'],
    ['MDM_REJECT_TYPE','MDM REJECT — Incorrect request type'],
    ['MDM_REJECT_CUST','MDM REJECT — Incorrect customer number'],
    ['DUPLICATE','Duplicate record exists'],
    ['MK_DENIAL_HIT','Watchlist (OFAC / MK Denials) match'],
    ['POLICY_VIOLATION','Policy violation / out of business rule scope'],
    ['OTHER','Other (explain in comment)'],
  ];
  rejectCodes.forEach(([c,l]) => refIns.run('REASON_REJECT', c, l, null, null));

  const rmiCodes = [
    ['QA_RMI_MISSING',   'QA — Missing / insufficient qualification documentation'],
    ['QA_RMI_INCORRECT', 'QA — Incorrect qualification documentation'],
    ['QA_RMI_DATA',      'QA — Incorrect data entry vs qualification docs'],
    ['CF_RMI_MISSING',   'Credit/Finance — Missing / insufficient finance documentation'],
    ['CF_RMI_INCORRECT', 'Credit/Finance — Incorrect finance documentation'],
    ['CF_RMI_DATA',      'Credit/Finance — Incorrect data entry vs finance docs'],
    ['MDM_RMI_APPROVAL', 'MDM — Missing approval (non-iDOT approver)'],
    ['MDM_RMI_MISSING',  'MDM — Missing / insufficient documentation'],
    ['MDM_RMI_INCORRECT','MDM — Incorrect documentation'],
    ['MDM_RMI_DATA_CUST','MDM — Incorrect data entry vs customer documentation'],
    ['MDM_RMI_DATA_STD', 'MDM — Incorrect data entry vs master data standards'],
    ['OTHER',            'Other (explain in comment)'],
  ];
  rmiCodes.forEach(([c,l]) => refIns.run('REASON_RMI', c, l, null, null));

  // -------- SLA CONFIG --------
  const slaIns = db.prepare(`INSERT INTO sla_config (domain,stage,assignee_role,sla_days,reminder_hours) VALUES (?,?,?,?,?)`);
  const slas = [
    ['VENDOR','ONBOARDING_REQUEST','BU_REQUESTOR',3,48],
    ['VENDOR','SUPPLY_CHAIN_REVIEW','SUPPLY_CHAIN',3,48],
    ['VENDOR','SOURCE_IDENTIFICATION','SUPPLY_CHAIN',10,72],
    ['VENDOR','VENDOR_ONBOARDING_FORM','BU_REQUESTOR',2,48],
    ['VENDOR','MK_DENIAL_REVIEW','LEGAL',1,48],
    ['VENDOR','ADVERSE_MEDIA','LEGAL',3,48],
    ['VENDOR','SUPPLIER_FORM','SUPPLIER',3,48],
    ['VENDOR','NDA_REVIEW','MASTER_ADMIN',1,48],
    ['VENDOR','ADMIN_REVIEW','MASTER_ADMIN',1,48],
    ['VENDOR','BANK_APPROVAL','MASTER_ADMIN',1,48],
    ['CUSTOMER','CUSTOMER_SERVICE_INIT','CUSTOMER_SERVICE',1,24],
    ['CUSTOMER','MDM_REVIEW','MDM_TEAM',2,48],
    ['CUSTOMER','QUALITY_REVIEW','QUALITY_REG',2,48],
    ['CUSTOMER','CORP_SECURITY_REVIEW','CORP_SECURITY',3,48],
    ['CUSTOMER','CREDIT_REVIEW','CREDIT_MGMT',2,48],
    ['CUSTOMER','FINANCE_REVIEW','FIN_MGMT',2,48],
    ['CUSTOMER','SALES_INPUT','SALES',2,48],
    ['CUSTOMER','SUPERVISOR_REVIEW','SUPERVISOR',1,24],
    ['PRODUCT','PRODUCT_OWNER_REVIEW','PRODUCT_OWNER',2,48],
    ['PRODUCT','ADMIN_REVIEW','MASTER_ADMIN',1,48],
  ];
  slas.forEach(s => slaIns.run(...s));

  // -------- SAMPLE VENDORS --------
  const vi = db.prepare(`INSERT INTO vendors
    (erp_supplier_id, legal_name, duns, tax_id, category_l1, category_l2, commodity_code, erp_instance,
     line_of_business, factory_or_field, currency_code, ap_payment_terms, high_level_class,
     primary_contact_name, primary_contact_email, primary_contact_phone, status, risk_rating, supplier_attribute)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sampleVendors = [
    ['SUP000001','Globex Industries Ltd','123456789','98-7654321','DIRECT','Electronics','CM001','GLOBAL_JDE','Manufacturing','Factory','USD','NET30','PO','Jane Globex','jane@globex.com','+1-555-0100','ACTIVE','LOW','LOCAL'],
    ['SUP000002','Initech Software Inc','987654321','12-3456789','INDIRECT','IT','CM001','SAP_S4','IT Services','Office','USD','NET45','NONPO','Bob Initech','bob@initech.com','+1-555-0200','ACTIVE','MEDIUM','LOCAL'],
    ['SUP000003','Hooli Logistics GmbH','555111222','DE123456789','DIRECT','Logistics','CM006','SAP_ECC','Freight','Field','EUR','NET60','PO','Klaus Hooli','klaus@hooli.de','+49-30-0000','ACTIVE','LOW','RHQ'],
    ['SUP000004','Pied Piper Solutions','222333444','23-4567890','INDIRECT','Consulting','CM005','GLOBAL_JDE','Services','Office','USD','NET30','MIXED','Erlich B','eb@piedpiper.com','+1-555-0404','PENDING','HIGH','LOCAL'],
    ['SUP000005','Massive Dynamic','111222333','45-6789012','DIRECT','Raw Materials','CM003','ORACLE_EBS','Chemicals','Factory','USD','NET45','PO','Nina Sharp','ns@massdyn.com','+1-555-0500','ACTIVE','MEDIUM','LOCAL'],
  ];
  sampleVendors.forEach(v => vi.run(...v));

  const ai = db.prepare(`INSERT INTO vendor_addresses (vendor_id,address_type,line1,city,state,zip,country) VALUES (?,?,?,?,?,?,?)`);
  ai.run(1,'PRIMARY','100 Globex Way','Sunnyvale','CA','94086','US');
  ai.run(2,'PRIMARY','1 Initech Tower','Austin','TX','78701','US');
  ai.run(3,'PRIMARY','Hoolistrasse 7','Berlin','','10115','DE');
  ai.run(4,'PRIMARY','500 Startup Blvd','Palo Alto','CA','94301','US');
  ai.run(5,'PRIMARY','9 Dynamic Plaza','New York','NY','10001','US');

  // -------- SAMPLE CUSTOMERS --------
  const ci = db.prepare(`INSERT INTO customers
    (erp_customer_id, legal_name, name_1, trade_name, customer_type, partner_function, customer_group, market,
     tax_id, duns, company_code, sales_org, distribution_ch,
     currency_code, payment_terms, credit_limit, incoterms, industry, region, country, postal_code, status,
     contact_name, contact_email, sox_flag, gxp_flag)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sampleCustomers = [
    ['CUS000001','Stark Industries','Stark Industries','Stark','SOLD_TO','SOLD_TO','OEM','US','98-1111111','111000111','US01','NA01','DIRECT','USD','NET30',500000,'DDP','Defense','NORTH_AMERICA','US','10001','ACTIVE','Tony Stark','tony@stark.com',1,0],
    ['CUS000002','Wayne Enterprises','Wayne Enterprises','Wayne Ent.','SOLD_TO','END_TO_END','OEM','US','45-2222222','222000222','US01','NA01','DIRECT','USD','NET45',1000000,'CIF','Diversified','NORTH_AMERICA','US','60601','ACTIVE','Bruce Wayne','bruce@wayne.com',1,0],
    ['CUS000003','Umbrella Corp','Umbrella Corp','Umbrella','BILL_TO','BILL_TO','PHARM','UK','33-3333333','333000333','GB01','EU01','DISTRIBUTOR','GBP','NET60',250000,'FOB','Pharmaceuticals','EMEA','GB','EC1A','ACTIVE','Albert Wesker','wesker@umbrella.co.uk',0,1],
    ['CUS000004','Tyrell Corporation','Tyrell Corporation','Tyrell','SOLD_TO','SOLD_TO','OEM','JP','22-4444444','444000444','JP01','AP01','RESELLER','JPY','NET30',750000,'EXW','Technology','APAC','JP','100-0001','PENDING','Eldon Tyrell','tyrell@tyrell.jp',1,0],
  ];
  sampleCustomers.forEach(c => ci.run(...c));

  // -------- SAMPLE PRODUCTS --------
  const pi = db.prepare(`INSERT INTO products
    (sku,name,description,product_type,material_group,base_uom,gross_weight,net_weight,weight_uom,
     country_of_origin,gtin,hs_code,lifecycle_status,standard_cost,currency)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sampleProducts = [
    ['SKU-10001','Industrial Widget 42','Heavy-duty steel widget, 42mm','FINISHED','MG002','EA',1.2,1.0,'KG','US','0012345000019','8479.90',  'ACTIVE', 15.50, 'USD'],
    ['SKU-10002','Polymer Pellet PE-400','High-density polyethylene pellets','RAW','MG003','KG',25.0,25.0,'KG','DE','0012345000026','3901.20',  'ACTIVE', 1.85, 'EUR'],
    ['SKU-20001','Professional Services - Installation','Onsite installation service, per hour','SERVICE','MG006','HR',null,null,null,'US',null,null,'ACTIVE', 120.00, 'USD'],
    ['SKU-30001','Control Module v3','Embedded controller module','FINISHED','MG001','EA',0.3,0.28,'KG','CN','0012345000033','8542.31',  'PENDING', 42.00, 'USD'],
  ];
  sampleProducts.forEach(p => pi.run(...p));

  console.log('[seed] done');
});

seed();
