<#-- keycloak/themes/deckgauge/login/error.ftl -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "form">
    <div class="vp-error">
      <h2 class="vp-error__title">Something went wrong</h2>
      <p class="vp-error__message">${kcSanitize(message.summary)?no_esc}</p>
      <#if client?? && client.baseUrl?has_content>
        <a class="vp-btn vp-btn--secondary" href="${client.baseUrl}">Back to Deckgauge</a>
      </#if>
    </div>
  </#if>
</@layout.registrationLayout>
