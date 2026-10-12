import NextAuth from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";

// Azure AD 앱에 등록된 redirect URI
const OIDC_CALLBACK_URL = `${process.env.NEXTAUTH_URL}/oidc/callback`;

const handler = NextAuth({
  providers: [
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
      tenantId: process.env.AZURE_AD_TENANT_ID!,
      // 1) 인가 요청 시 redirect_uri = /oidc/callback
      authorization: {
        params: {
          redirect_uri: OIDC_CALLBACK_URL,
        },
      },
      // 2) 토큰 교환 시도 동일한 redirect_uri 사용 (AADSTS500112 방지)
      //    token.params 는 exchangeBody로 전달되지만 callbackUrl이 우선하므로
      //    token.request 로 직접 openid-client 호출을 가로챔
      token: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async request({ client, params, checks }: any) {
          const tokens = await client.callback(
            OIDC_CALLBACK_URL,
            params,
            checks,
          );
          return { tokens };
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async session({ session, token }) {
      if (session.user && token.email) {
        session.user.email = token.email;
      }
      return session;
    },
  },
});

export { handler as GET, handler as POST };
