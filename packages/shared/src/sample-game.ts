// The sample game: a real game from the Lichess database (CC0), the Player as White. A Player with
// no games yet can try a Review on it from the main menu, and verify mode seeds it as game 1.
export const SAMPLE_GAME_PGN = `[Event "Rated Classical game"]
[Site "https://lichess.org/i425hmuv"]
[White "bijean"]
[Black "ikatsca"]
[Result "0-1"]
[UTCDate "2013.01.05"]
[WhiteElo "1456"]
[BlackElo "1645"]
[ECO "C54"]
[Opening "Italian Game: Giuoco Piano, Greco's Attack"]
[TimeControl "360+3"]
[Termination "Normal"]

1. e4 e5 2. Bc4 Nc6 3. Nf3 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4 8. O-O O-O 9. Nxe4 d5 10. a3 dxe4 11. Bxf7+ Rxf7 12. Bg5 Qd5 13. Ne5 Nxe5 14. axb4 Nd3 15. Be3 Nxb4 16. Rc1 Nc6 17. Rc5 Qd7 18. d5 Ne5 19. Bd4 Nd3 20. Rc3 Qxd5 21. Be3 Be6 22. b3 Rd8 23. Rc5 Nxc5 24. Bxc5 Qxd1 0-1
`;

/** The side the Player had in the sample game. */
export const SAMPLE_GAME_SIDE = 'white';
