<#-- keycloak/themes/deckgauge/login/template.ftl -->
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${msg("loginTitle",(realm.displayName!''))}</title>
  <link rel="icon" href="${url.resourcesPath}/img/logo.svg" type="image/svg+xml">
  <#if properties.styles?has_content>
    <#list properties.styles?split(' ') as style>
      <link rel="stylesheet" href="${url.resourcesPath}/${style}">
    </#list>
  </#if>
</head>
<body class="vp-body ${bodyClass}" data-theme="deckgauge">
  <main class="vp-shell">
    <section class="vp-card">
      <header class="vp-header">
        <img class="vp-logo" src="${url.resourcesPath}/img/logo.svg" alt="Deckgauge" width="48" height="48">
        <h1 class="vp-title">Welcome to Deckgauge</h1>
        <p class="vp-subtitle">Manage your engineering portfolio</p>
      </header>

      <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
        <div class="vp-alert vp-alert--${message.type}">
          <#if message.type = 'success'><span aria-hidden="true">✓</span></#if>
          <#if message.type = 'warning'><span aria-hidden="true">⚠</span></#if>
          <#if message.type = 'error'><span aria-hidden="true">✕</span></#if>
          <span class="vp-alert__text">${kcSanitize(message.summary)?no_esc}</span>
        </div>
      </#if>

      <div class="vp-body-slot">
        <#nested "form">
      </div>

      <#if displayInfo>
        <footer class="vp-footer">
          <#nested "info">
        </footer>
      </#if>
    </section>
  </main>
</body>
</html>
</#macro>
