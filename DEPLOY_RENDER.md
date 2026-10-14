# Render pe deploy (public live link)

Ye demo ek hi server hai (dashboard + sellers + buyer agent + keeper) jo Avalanche **Fuji** se baat karta hai.
Render pe free plan kaafi hai. Poora kaam 10-15 minute ka hai.

## Pehle ye samajh lo
- Server ko 4 **private keys** chahiye (test wallets: deployer, seller A, seller B, buyer). Ye aapke computer ki `.env` file me hain.
- Ye keys **sirf Render ke settings me** paste karni hain. GitHub pe, chat me, ya kisi aur ko kabhi mat bhejna. (`.env` GitHub pe jaati hi nahi, `.gitignore` me hai.)
- Ye wallets sirf test AVAX aur test token wale hain, asli paisa nahi.
- Contract Fuji pe pehle se deploy hai. Render pe dobara deploy nahi karna.

## Steps
1. https://render.com kholo, **Sign up with GitHub** se account banao.
2. Dashboard me **New +** dabao, phir **Blueprint** chuno.
3. Repo `priyanshi020/Surety` chuno. Render `render.yaml` apne aap padh lega aur service `surety-demo` dikhayega.
4. Wo 4 secret values maangega. Apne computer pe `C:\Users\MST-Sales\Documents\surety\.env` file Notepad me kholo. Isme aise lines hain:
   ```
   DEPLOYER_KEY=0x....
   SELLER_A_KEY=0x....
   SELLER_B_KEY=0x....
   BUYER_KEY=0x....
   ```
   Har line me `=` ke **baad** wali poori value copy karke Render ke us naam wale box me paste karo (`0x` samet).
5. **Apply / Deploy** dabao. Pehli baar 5-8 minute lagte hain (`npm install`). Logs me "Surety demo on http://localhost:..." dikhe to server chal gaya.
6. Upar service ka link milega, jaise `https://surety-demo.onrender.com`. Wahi aapka public live link hai.

## Check karo
- Link kholo. Dashboard dikhna chahiye, "Avalanche Fuji · chain 43113" ke saath, aur dono sellers ke saath.
- **Run buyer agent** dabao. Kuch second me "SETTLED" aana chahiye.
- Judges ko link dene se pehle khud ek baar check kar lo.

## Dhyan rakho
- **Free plan sleep karta hai:** 15 minute koi na aaye to server so jata hai, aur agli baar khulne me 30-60 second lagte hain. Demo ya judging se pehle link ek baar khol lo.
- **Ek baar me ek hi demo run chalta hai.** Agar koi aur run kar raha hai to "Another demo run is in progress" dikhega. Ye isliye hai ki public hone par koi test AVAX khali na kar de.
- **Test AVAX khatam ho sakta hai.** Har run ke liye thoda gas lagta hai. Agar runs fail hone lage to deployer ko faucet se aur AVAX bhejo, phir `npm run setup:fuji` chalao (ye seller/buyer wallets ko top-up karta hai).
- Koi "Make it lie" ya "go silent" dabake sellers ki mode badal sakta hai. Server restart par sab "honest" ho jaate hain.
- Agar contract dobara deploy karo (`npm run deploy:fuji`), to `deployments/fuji.json` badlega. Use GitHub pe push karo, tab Render naya deploy utha lega.
