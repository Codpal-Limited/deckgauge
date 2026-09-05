<#-- keycloak/themes/vp-cockpit/login/login.ftl -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password'); section>
  <#if section = "form">
    <form id="kc-form-login" action="${url.loginAction}" method="post" class="vp-form" novalidate>
      <label class="vp-label" for="username">
        <span class="vp-label__text">Email</span>
        <input
          tabindex="1"
          id="username"
          class="vp-input"
          name="username"
          value="${(login.username!'')}"
          type="email"
          autofocus
          autocomplete="email"
          aria-invalid="<#if messagesPerField.existsError('username','password')>true<#else>false</#if>"
          placeholder="you@example.com"
        />
      </label>

      <label class="vp-label" for="password">
        <span class="vp-label__text">Password</span>
        <input
          tabindex="2"
          id="password"
          class="vp-input"
          name="password"
          type="password"
          autocomplete="current-password"
          aria-invalid="<#if messagesPerField.existsError('username','password')>true<#else>false</#if>"
          placeholder="••••••••"
        />
      </label>

      <#if realm.resetPasswordAllowed>
        <p class="vp-forgot">
          <a tabindex="5" href="${url.loginResetCredentialsUrl}" class="vp-link">Forgot password?</a>
        </p>
      </#if>

      <#if messagesPerField.existsError('username','password')>
        <div class="vp-field-error">${kcSanitize(messagesPerField.getFirstError('username','password'))?no_esc}</div>
      </#if>

      <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
      <button tabindex="3" class="vp-btn vp-btn--primary" name="login" id="kc-login" type="submit">Sign in</button>
    </form>

    <#if realm.password && social.providers?? && social.providers?has_content>
      <div class="vp-divider"><span>or</span></div>
      <div class="vp-social">
        <#list social.providers as p>
          <a id="social-${p.alias}" class="vp-btn vp-btn--secondary vp-btn--social" href="${p.loginUrl}">
            <span>Continue with ${p.displayName!p.alias}</span>
          </a>
        </#list>
      </div>
    </#if>

    <#if realm.registrationAllowed && !registrationDisabled??>
      <p class="vp-meta">
        New here? <a tabindex="6" href="${url.registrationUrl}" class="vp-link">Create an account</a>
      </p>
    </#if>
  </#if>
</@layout.registrationLayout>
