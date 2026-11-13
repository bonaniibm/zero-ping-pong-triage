// Inbound flow: ERP -> Service Bus queue "erp-contacts" -> this Function -> Dataverse contact.
const { app } = require('@azure/functions');
const { client } = require('../lib/dataverse');

const esc = (s) => String(s).replace(/'/g, "''");

app.serviceBusQueue('syncContact', {
  connection: 'SERVICEBUS_CONNECTION',
  queueName: 'erp-contacts',
  handler: async (message, context) => {
    const msg = typeof message === 'string' ? JSON.parse(message) : message;
    const dv = client('INTEGRATION');
    const base = { externalId: msg.externalId, email: msg.email, deliveryCount: context.triggerMetadata?.deliveryCount };

    try {
      const record = {
        firstname: msg.firstName,
        lastname: msg.lastName,
        emailaddress1: msg.email,
        description: `Synced from ERP (${msg.externalId})`,
      };

      if (msg.accountNumber) {
        const acc = await dv.get(`accounts?$select=accountid&$filter=accountnumber eq '${esc(msg.accountNumber)}'&$top=1`);
        if (!acc.value.length) {
          const e = new Error(`Parent account with accountnumber '${msg.accountNumber}' does not exist in Dataverse`);
          e.category = 'DataValidation';
          throw e;
        }
        record['parentcustomerid_account@odata.bind'] = `/accounts(${acc.value[0].accountid})`;
      }

      const existing = await dv.get(`contacts?$select=contactid&$filter=emailaddress1 eq '${esc(msg.email)}'&$top=1`);
      const result = existing.value.length
        ? await dv.patch(`contacts(${existing.value[0].contactid})`, record)
        : await dv.post('contacts', record);

      context.log('ContactSynced', JSON.stringify({ ...base, dataverseRequestId: result.requestId }));
    } catch (err) {
      // One structured line per failure so it is easy to find from Application Insights.
      context.error('ContactSyncFailed', JSON.stringify({
        ...base,
        category: err.category || (err.name === 'DataverseError' ? 'DataverseRejected' : 'Unexpected'),
        httpStatus: err.status,
        dataverseRequestId: err.dataverseRequestId,
        dataverseErrorCode: err.dataverseErrorCode,
        entraError: err.entraError,
        message: err.message,
      }));
      throw err; // let Service Bus retry, then dead-letter
    }
  },
});
