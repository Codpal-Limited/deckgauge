<#-- keycloak/themes/deckgauge/login/register.ftl -->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('firstName','lastName','email','username','password','password-confirm'); section>
  <#if section = "form">
    <form id="kc-register-form" action="${url.registrationAction}" method="post" class="vp-form" novalidate>
      <label class="vp-label" for="firstName">
        <span class="vp-label__text">First name</span>
        <input type="text" id="firstName" class="vp-input" name="firstName" value="${(register.formData.firstName!'')}" autocomplete="given-name" />
      </label>

      <label class="vp-label" for="lastName">
        <span class="vp-label__text">Last name</span>
        <input type="text" id="lastName" class="vp-input" name="lastName" value="${(register.formData.lastName!'')}" autocomplete="family-name" />
      </label>

      <label class="vp-label" for="email">
        <span class="vp-label__text">Email</span>
        <input type="email" id="email" class="vp-input" name="email" value="${(register.formData.email!'')}" autocomplete="email" placeholder="you@example.com" />
      </label>

      <#if passwordRequired??>
        <label class="vp-label" for="password">
          <span class="vp-label__text">Password</span>
          <input type="password" id="password" class="vp-input" name="password" autocomplete="new-password" />
        </label>

        <label class="vp-label" for="password-confirm">
          <span class="vp-label__text">Confirm password</span>
          <input type="password" id="password-confirm" class="vp-input" name="password-confirm" autocomplete="new-password" />
        </label>
      </#if>

      <#if messagesPerField.existsError('firstName','lastName','email','password','password-confirm')>
        <div class="vp-field-error">
          ${kcSanitize(messagesPerField.getFirstError('firstName','lastName','email','password','password-confirm'))?no_esc}
        </div>
      </#if>

      <button class="vp-btn vp-btn--primary" type="submit">Create account</button>

      <p class="vp-meta">
        Already have an account? <a href="${url.loginUrl}" class="vp-link">Sign in</a>
      </p>
    </form>
  </#if>
</@layout.registrationLayout>
