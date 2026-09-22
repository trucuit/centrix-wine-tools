# 🔐 Thông Tin Tài Khoản & Mật Khẩu Hệ Thống CentriX

> **⚠️ TÀI LIỆU BẢO MẬT - KHÔNG CHIA SẺ**
> Cập nhật: 2026-09-22

---

## 1. VPS & SSH Credentials

### 1.1. VPS CentriX chính — `103.240.7.254`
| Thông tin | Giá trị |
|:---|:---|
| **IP** | `103.240.7.254` |
| **OS** | Ubuntu 24.04 x86_64 |
| **User** | `root` |
| **Password** | `kh6PiFhF9ekG!xmK` |
| **SSH** | `ssh root@103.240.7.254` |

### 1.2. VPS CentriX — `163.223.224.240`
| Thông tin | Giá trị |
|:---|:---|
| **IP** | `163.223.224.240` |
| **User** | `root` / `centrix-admin` |
| **Password** | `CentriX@890020` |
| **SSH** | `ssh root@163.223.224.240` |
| **Admin Panel** | `http://163.223.224.240:3080` |
| **Admin Email** | `admin@centrix.local` |
| **Admin Pass** | `_838IPT0qaVPoQT8yDGZnhM-` |

### 1.3. VPS CentriX — `118.69.40.114`
| Thông tin | Giá trị |
|:---|:---|
| **IP** | `118.69.40.114` |
| **User** | `admin-centrix` |
| **Password** | `Centrix1608@` |
| **SSH** | `ssh admin-centrix@118.69.40.114` |

### 1.4. PC Server nội bộ
| Thông tin | Giá trị |
|:---|:---|
| **IP LAN** | `192.168.2.159` / `192.168.1.159` |
| **User** | `admin-centrix` |
| **Password** | (dùng mật khẩu sudo/SSH của máy) |

---

## 2. Web Hosting — cPanel AZDIGI

> **Lưu ý:** `103.221.220.82` là IP Shared Hosting (cPanel), KHÔNG phải VPS.

| Thông tin | Giá trị |
|:---|:---|
| **Domain** | `software.centrix.asia` |
| **IP** | `103.221.220.82` |
| **Host** | `pbf-epyc-22118.azdigihost.com` |
| **cPanel URL** | `https://pbf-epyc-22118.azdigihost.com:2083` |
| **Username** | `gxtypraq` |
| **Password** | `Centrix2026@@` |
| **FTP Port** | `21` |
| **FTP Users** | `admin@software.centrix.asia`, `upload@software.centrix.asia` |

---

## 3. CentriX Backend — Admin & API

### 3.1. Tài khoản Staff / Admin Owner
| Thông tin | Giá trị |
|:---|:---|
| **URL** | `https://admin.centrix.software/login` |
| **API** | `https://api-centrixapp-quang.centrix.asia/` |
| **Email** | `owner@centrix.asia` |
| **Password** | `ypxE_N99iSbMGjGRHXBPgr` |
| **Admin khác** | `quang@centrix.asia` (có trong DB) |

### 3.2. Master Token (bypass Admin trên mọi API)
```
cxm_2820cd066030366f3b304a17cb86531dcb9c1b38aec2fde7a78d884c12e586ae
```

### 3.3. API Proxy Management
- URL: `https://api-proxy.centrix.asia/management.html#/oauth`

---

## 4. Tài Khoản OpenAI / Codex

### 4.1. `gptpro2@centrix.biz` (Codex / auth.openai.com)
| Thông tin | Giá trị |
|:---|:---|
| **Email** | `gptpro2@centrix.biz` |
| **Password** | `H#488104983025ow` |
| **2FA Secret** | `N7NM2WTN4DKTZ3VPHI4WM2AN747DYA5F` |
| **TOTP Cmd** | `oathtool --totp -b N7NM2WTN4DKTZ3VPHI4WM2AN747DYA5F` |

### 4.2. `xuanloc@centrix.asia` (Azure AD / Microsoft Entra)
| Thông tin | Giá trị |
|:---|:---|
| **Email** | `xuanloc@centrix.asia` |
| **Azure UPN** | `xuanloc@centrixcorp.onmicrosoft.com` |
| **Password** | ⚠️ Không có plaintext — cần reset qua [Microsoft Entra Admin Center](https://entra.microsoft.com) |
| **2FA Secret** | `3H5FRI3XCHSOJ74USLU22SJFNU4ECH6Y` |
| **TOTP Cmd** | `oathtool --totp -b 3H5FRI3XCHSOJ74USLU22SJFNU4ECH6Y` |

### 4.3. Codex Team OAuth Accounts (Token Auth — không dùng password)
| Email |
|:---|
| `sale.swvn@cix.vn` |
| `operation.swvn@cix.vn` |
| `mkt.swvn@cix.vn` |
| `bussines6@cxai.vn` |
| `bussines7@cxai.vn` |
| `acc.swvn@cix.vn` |
| `legal.swvn@cix.vn` |
| `chatgpt.mobi7@centrix.asia` |
| `khoap.hamg.nka7144@gmail.com` |
| `lnguyetb99ff9+1@gmail.com` |

> Token auth files: `vps-auths/codex-*-<email>-team.json`

---

## 5. Tài Khoản AI & Dịch vụ Khác

### 5.1. Claude Pro
| Email | Password |
|:---|:---|
| `t01064286279@gmail.com` | `GGG123456789a@` |
| `t01064300032@gmail.com` | `GGG123456789a@` |
| `t01064341958@gmail.com` | `GGG123456789a@` |

### 5.2. ChatGPT Plus / SuperGrok / Business
| Dịch vụ | Email | Password | Ghi chú |
|:---|:---|:---|:---|
| ChatGPT Plus + SuperGrok | `ai.karofi.vn@centrix.biz` | `x%586046565342at` | Karofi R&D |
| ChatGPT Business | `gptbussiness.karofi.vn@centrix.biz` | `x%586046565342at` | Gói 3 tháng Karofi |
| ChatGPT / Email | `anhtran8301@gmail.com` | `Tuananh@123` | — |

### 5.3. xAI / Grok 2FA
| Email | 2FA Secret |
|:---|:---|
| `oldturbo@giasieusale.site` | `E4YT6OULLDRMRQQBKXXANW3QDCNF3GU3` |
| `grokcentrix@signs.onmicrosoft.com` | `45RIF66QRZPETXD5R3NYI2G3KU5EYIRD` |

### 5.4. Dịch vụ GGG
| Thông tin | Giá trị |
|:---|:---|
| **Email** | `vanhoa@ggg.com.vn` |
| **Password** | `A123456789b@` |
| **2FA Key** | `OYNG47K25QZBIO3LDSMHWYS3CSJNSJCK` (get2fa.vn) |

### 5.5. Zoom Pro
| Email | Password | 2FA Secret |
|:---|:---|:---|
| `summerwind58@gmail.com` | `Summerwind58` | `U3LZYVUPHWD2A4HZ` |
| `nguyenthihoa912203@gmail.com` | — | `YRZYKV47V7GZQURW` |

### 5.6. Cursor Pro / Edu
| Email | Password |
|:---|:---|
| `tremblaydaniel981@sonacreativecop.com` | `Admin123@` |
| `JamelhErsonlucir@hotmail.com` | `ElenaKellie09` / `lequydon2000#` |
| `rusazin2@hornets.hssu.edu` | `Charles13498!` |
| `sleepingc21@hornets.hssu.edu` | `Zvw2297843!` |
| `sweisler@bucs.fsw.edu` | `Zvw2297843!` |
| `rangizl_URgroup@u.rochester.edu` | `Ravish1828@` |
| `kleeds038@hornets.hssu.edu` | `SABka259884!` |
| `baydi388_urgroup@u.rochester.edu` | `Rasn1248090!` |

### 5.7. Hotmail / Gmail phụ
| Email | Password |
|:---|:---|
| `lamorennr247367@hotmail.com` | `acOWM7fz28` |
| `TawaskiTempka99@hotmail.com` | `12345678` |
| `CatalanattoScotton156@hotmail.com` | `1234567` |
| `Bryan.cmgreal@gmail.com` | `Bryan1996@` |
| `JHenriques88141@dominics-int.pt` | `Sanquel@@9264` |

---

## 6. Mạng & Internet

| Mục | Địa chỉ / SSID | User | Password |
|:---|:---|:---|:---|
| Modem FPT | `192.168.1.1` | `admin` | `37832DB26D` |
| Wi-Fi | `FPT Telecom-E451` | — | `25BA4EB2` |
| PPPoE FPT | HĐ `Sgfdl-251208-7914` | `Sgfdl-251208-7914` | `aev7914` |

---

## 7. Remote Desktop

| Phần mềm | ID | Password |
|:---|:---|:---|
| TeamViewer | `1 102 141 827` | `zzeihnmc` / `wlc623s7` |
| TeamViewer/UV | `215 270 830` | `bqn8x1` |
| UltraViewer | `74 342 894` | `47461` |

---

## 8. CapCut Team (Mật khẩu chung: `Capcut123@`)

| Email | UID |
|:---|:---|
| `d4oudr7bwm@vulgl.capcut13.name.ng` | `7594443295586157623` |
| `f7f02xec7z@capcut95.name.ng` | `7594443294160962615` |
| `ntgap57y6j@tztii.adubadu.io.vn` | `7594443294161355831` |
| `3kgg7hr9it@m6va.capcut11.name.ng` | `7594443295586796599` |
| `q9mul28as3@mailcc23.name.ng` | `7594443295587206199` |
| `jri5dik0jx@bibjl.anglis.io.vn` | `7594443321503646734` |
| `7j1i711cuf@wosmc.blasis.io.vn` | `7594443322115425293` |
| `zuwjlk129c@jpyqm.blasis.io.vn` | `7594443322115867661` |
| `0o86o7pb0u@mqoqi.blema.io.vn` | `7594443342608417805` |
| `n6sj1vga2n@mailcc22.name.ng` | `7594443322116260877` |
| `92sc8rmpjy@tpxoy.blema.io.vn` | `7594443347675612173` |
| `a6h1uiya1a@ltria3.name.ng` | `7594443364788618253` |
| `iwnmwjgl0q@v1hw.capcut11.name.ng` | `7594443368894694413` |
| `hk4r4b119w@ltria21.name.ng` | `7594443368894759949` |
| `sox6vyhem5@tztii.adubadu.io.vn` | `7594443388376679437` |
| `1ca8dt31wx@jwobi.adubadu.io.vn` | `7594443388376908813` |

> 2 tài khoản dùng pass `a123456`: `4lhnml82nx@nwsbcq3b8tip.capcut1.name.ng`, `5l80cumr91@pevie.cutflow.io.vn`

---

## 9. Tài Khoản Ngân Hàng

| Ngân hàng | STK | Chủ TK | Ghi chú |
|:---|:---|:---|:---|
| MB Bank | `999978888` | CÔNG TY CỔ PHẦN CENTRIX | STK chính công ty |
| TPBank | `00000290281` | CÔNG TY CỔ PHẦN CENTRIX | Dòng tiền |
| TPBank | `83867298888` | CÔNG TY CỔ PHẦN CENTRIX | Dòng tiền |
| TPBank | `10002072033` | PHAM HOANG QUAN | Cá nhân |
| TPBank | `0191 4914 001` | ĐÀO ĐỨC LIÊU | Đối tác |
| Techcombank | `1903 7939 0390 17` | TRAN TUAN HUNG | Giao dịch |
| MB Bank | `03866483230412` | NGUYEN TRUNG THINH | Giao dịch |
| VietinBank | `102877471651` | ĐOÀN TUẤN THANH | Hoàn tiền |

---

## 10. Thông Tin Định Danh & Khác

| Mục | Giá trị |
|:---|:---|
| **CCCD** | `075203015408` |
| **Microsoft Partner ID** | `7137148` |
| **Mã số thuế Meta** | `9000000327` |

---

> **Ghi chú bảo mật:**
> - Mật khẩu `xuanloc@centrix.asia` không có dạng plaintext trong hệ thống DB (dùng `pbkdf2$210000$salt$hash`). Cần reset qua [Microsoft Entra Admin Center](https://entra.microsoft.com).
> - Token auth cho Codex/Claude/Antigravity/xAI được lưu tại thư mục `vps-auths/` (JSON), đồng bộ qua script `scripts/import-vps-auths.mjs`.
> - File cấu hình backend `.env` chứa Master Token và DB credentials.
