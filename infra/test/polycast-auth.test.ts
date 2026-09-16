import { Template, Match } from 'aws-cdk-lib/assertions';
import { buildPolycastApp } from './polycast-fixture';
import { buildClaims, handler } from '../lambda/pre-token-generation/index';

describe('PolycastAuthStack', () => {
  const { auth } = buildPolycastApp({ webOrigins: ['https://app.example.test'] });
  const template = Template.fromStack(auth);

  test('user pool: invite-only, email sign-in, strong passwords, optional TOTP, retained', () => {
    template.hasResource('AWS::Cognito::UserPool', {
      Properties: Match.objectLike({
        AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
        UsernameAttributes: ['email'],
        AutoVerifiedAttributes: ['email'],
        Policies: {
          PasswordPolicy: Match.objectLike({
            MinimumLength: 12,
            RequireLowercase: true,
            RequireUppercase: true,
            RequireNumbers: true,
            RequireSymbols: true,
          }),
        },
        MfaConfiguration: 'OPTIONAL',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        AccountRecoverySetting: {
          RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }],
        },
        DeletionProtection: 'ACTIVE',
      }),
      DeletionPolicy: 'Retain',
    });
  });

  test('custom attributes org_ids (2048 chars, mutable) and role', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({
          Name: 'org_ids',
          AttributeDataType: 'String',
          Mutable: true,
          StringAttributeConstraints: { MaxLength: '2048', MinLength: '0' },
        }),
        Match.objectLike({ Name: 'role', AttributeDataType: 'String', Mutable: true }),
      ]),
    });
  });

  test('pre-token-generation trigger is a Node 22 function wired to the pool', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x' });
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PreTokenGeneration: Match.objectLike({ 'Fn::GetAtt': Match.anyValue() }) },
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'cognito-idp.amazonaws.com',
    });
  });

  test('app client: SRP + refresh, no secret, 1 h access / 30 d refresh, hosted UI domain', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'polycast-web',
      GenerateSecret: false,
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']),
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
      CallbackURLs: ['https://app.example.test/auth/callback'],
      PreventUserExistenceErrors: 'ENABLED',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'polycast-test' });
    template.hasOutput('UserPoolId', {});
    template.hasOutput('UserPoolClientId', {});
    template.hasOutput('HostedUiUrl', {});
  });
});

describe('pre-token-generation handler', () => {
  test('turns space-separated custom:org_ids into a JSON array claim and copies role', () => {
    expect(
      buildClaims({
        'custom:org_ids': ' 019 a1b  c2d ',
        'custom:role': 'producer',
        email: 'v@example.test',
        name: 'V',
      }),
    ).toEqual({
      org_ids: '["019","a1b","c2d"]',
      role: 'producer',
      email: 'v@example.test',
      name: 'V',
    });
  });

  test('missing attributes yield an empty org_ids array and no role claim', () => {
    expect(buildClaims({})).toEqual({ org_ids: '[]' });
  });

  test('handler writes claimsToAddOrOverride on the event', async () => {
    const event = {
      request: { userAttributes: { 'custom:org_ids': 'org-1', 'custom:role': 'admin' } },
      response: {},
    };
    const result = await handler(event);
    expect(result.response.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      org_ids: '["org-1"]',
      role: 'admin',
    });
  });
});
