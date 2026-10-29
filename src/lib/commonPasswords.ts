/**
 * ~300 of the most common passwords (lower-case), compiled from public breach-frequency
 * lists. Used offline by vaultHealth to flag weak passwords; never sent anywhere.
 */
const LIST = `
123456 password 123456789 12345678 12345 qwerty 1234567 111111 1234567890 123123 abc123 1234 password1 iloveyou
1q2w3e4r 000000 qwerty123 zaq12wsx dragon sunshine princess letmein 654321 monkey 27653 1qaz2wsx 123321 qwertyuiop
superman asdfghjkl trustno1 jordan23 welcome welcome1 admin admin123 administrator root toor passw0rd p@ssw0rd p@ssword
pass pass123 pass1234 password123 password12 password! changeme default guest login master hello hello123 test test123
testing secret secret123 football baseball basketball soccer hockey jordan michael michelle jennifer jessica ashley
daniel charlie andrew joshua matthew robert thomas hunter ranger buster shadow tigger tiger lovely loveme love123
iloveu iloveyou1 freedom whatever starwars batman pokemon naruto minecraft computer internet google samsung apple
mustang harley ferrari porsche corvette mercedes cheese pepper ginger banana orange chocolate cookie summer winter
spring autumn flower forever friends family london berlin paris america canada india pakistan mumbai delhi
qazwsx qazwsxedc asdf asdf1234 asdfgh asdfghjk zxcvbn zxcvbnm zxcvbnm123 qweasd qweasdzxc qwe123 qwer1234 1q2w3e
1q2w3e4r5t 1qaz2wsx3edc q1w2e3r4 a1b2c3 a1b2c3d4 abcd1234 abcdef abcdefg abc12345 aaaaaa aa123456 112233 121212 123654
123qwe 123abc 1234qwer 159753 147258369 147258 159357 13579 2468 696969 777777 888888 999999 666666 555555 222222
333333 444444 7777777 11111111 00000000 987654321 9876543210 0987654321 12341234 123123123 1122334455 11223344
monkey123 dragon123 shadow123 master123 killer hunter2 jordan1 ashley1 michael1 superman1 batman1 charlie1 qwerty1
qwerty12 qwerty1234 123456a 123456q a123456 q123456 1234567a 12345a 123456789a password01 passwort motdepasse
contraseña senha parola salasana wachtwoord haslo qwertz azerty 1qazxsw2 zaq1zaq1 zaq1xsw2 !qaz2wsx 1q2w3e4r5t6y
lol123 lolipop sweety angel angel1 babygirl baby123 princess1 sunshine1 flower1 rainbow purple yellow silver golden
diamond blessed jesus god heaven nothing secret1 whatever1 trustme letmein1 welcome123 access access14 mypass mypassword
myspace facebook instagram twitter linkedin youtube yahoo hotmail outlook gmail office office365 windows microsoft
server oracle mysql postgres database system system32 user user123 demo demo123 sample temp temp123 test1 test1234
qwerty321 abcabc xxxxxx zzzzzz azerty123 soccer1 football1 baseball1 maggie buddy bailey coffee matrix hockey1 nicole
thunder cowboy merlin startrek dakota diablo chelsea arsenal liverpool manchester barcelona realmadrid juventus
`;

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(LIST.split(/\s+/).filter(Boolean));
