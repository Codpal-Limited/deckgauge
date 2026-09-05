<#-- keycloak/themes/vp-cockpit/login/login-reset-password.ftl -->
<#-- Step 1 of the reset flow: ask where to send the link. Without this file the
     page inherits the stock keycloak template, whose markup uses kc-* classes
     that this theme's stylesheet does not define — so it renders unstyled
     inside our card. -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username'); section>
  <#if section = "form">
    <form id="kc-reset-password-form" action="${url.loginAction}" method="post" class="vp-form" novalidate>
      <p class="vp-lead">
        Enter your email address and we'll send you a link to choose a new password.
      </p>

      <label class="vp-label" for="username">
        <span class="vp-label__text">Email</span>
        <input
          type="email"
          id="username"
          class="vp-input"
          name="username"
          value="${(auth.attemptedUsername!'')}"
          autofocus
          autocomplete="email"
          placeholder="you@example.com"
          aria-invalid="<#if messagesPerField.existsError('username')>true<#else>false</#if>"
        />
      </label>

      <#if messagesPerField.existsError('username')>
        <div class="vp-field-error">${kcSanitize(messagesPerField.get('username'))?no_esc}</div>
      </#if>

      <button class="vp-btn vp-btn--primary" type="submit">Send reset link</button>

      <p class="vp-meta">
        <a href="${url.loginUrl}" class="vp-link">Back to sign in</a>
      </p>
    </form>
  </#if>
</@layout.registrationLayout>
