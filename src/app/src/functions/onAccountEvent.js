// Outbound flow: Dataverse account create -> service endpoint -> Service Bus queue "dataverse-events" -> this Function.
const { app } = require('@azure/functions');

app.serviceBusQueue('onAccountEvent', {
  connection: 'SERVICEBUS_CONNECTION',
  queueName: 'dataverse-events',
  handler: async (message, context) => {
    // Dataverse posts its RemoteExecutionContext as JSON.
    const ctx = typeof message === 'string' ? JSON.parse(message) : message;
    const target = (ctx.InputParameters || []).find((p) => p.key === 'Target')?.value;
    const name = (target?.Attributes || []).find((a) => a.key === 'name')?.value;

    context.log('AccountEventReceived', JSON.stringify({
      messageName: ctx.MessageName,
      entity: ctx.PrimaryEntityName,
      accountId: ctx.PrimaryEntityId,
      accountName: name,
      dataverseCorrelationId: ctx.CorrelationId,
      dataverseRequestId: ctx.RequestId,
    }));
    // A real integration would forward the account to the ERP here.
  },
});
