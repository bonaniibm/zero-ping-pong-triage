using System;
using Microsoft.Xrm.Sdk;

namespace Zpp.Plugins
{
    /// <summary>
    /// Demo plug-in for chaos scenario 2 ("plug-in regression after a release").
    /// It normalises the mobile phone number of a contact before save.
    /// The bug is deliberate: it assumes every contact has a mobile phone,
    /// which is true for contacts typed in by sales users and false for
    /// contacts written by the ERP integration.
    /// </summary>
    public class ContactEnrichmentPlugin : IPlugin
    {
        public void Execute(IServiceProvider serviceProvider)
        {
            var context = (IPluginExecutionContext)serviceProvider.GetService(typeof(IPluginExecutionContext));
            var trace = (ITracingService)serviceProvider.GetService(typeof(ITracingService));

            trace.Trace("ContactEnrichmentPlugin v1.3.0 start. Message={0}, Depth={1}", context.MessageName, context.Depth);

            if (!(context.InputParameters["Target"] is Entity target) || target.LogicalName != "contact")
            {
                return;
            }

            trace.Trace("Normalising mobile phone for contact {0}", target.GetAttributeValue<string>("emailaddress1"));

            // BUG (deliberate): GetAttributeValue returns null when the caller did not send mobilephone.
            string mobile = target.GetAttributeValue<string>("mobilephone");
            string normalised = mobile.Replace(" ", string.Empty).Replace("-", string.Empty);

            target["mobilephone"] = normalised;
            trace.Trace("Mobile phone normalised to {0}", normalised);
        }
    }
}
