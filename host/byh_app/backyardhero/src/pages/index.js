import Head from "next/head";
import MainNav from "@/components/MainNav";

export default function Home() {
  return (
    <>
      <Head>
        <title>Backyard Hero — Operator Console</title>
        <meta name="description" content="Backyard Hero pyrotechnic firing console" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <MainNav />
    </>
  );
}
