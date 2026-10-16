import java.io.BufferedReader;
import java.io.FileReader;
import java.nio.file.Files;
import java.nio.file.Path;
// The credential crosses a RAM-backed FIFO, never argv, environment or a regular file.
class AgentLauncher {
    public static void main(String[] args) throws Exception {
        Path fifo = Path.of("/run/native-ci/agent-secret");
        String secret = new BufferedReader(new FileReader(fifo.toFile())).readLine();
        Files.delete(fifo);
        if (secret == null || !secret.matches("[a-f0-9]+")) throw new IllegalArgumentException("Missing agent credential");
        // Configure the launcher directly: its CLI usage printer exposes parsed defaults.
        hudson.remoting.Launcher launcher = new hudson.remoting.Launcher();
        launcher.urls.add(java.net.URI.create("https://jenkins:8443/").toURL());
        launcher.name = "flexo-validation-local-v2";
        launcher.secret = secret;
        launcher.webSocket = true;
        launcher.candidateCertificates = new java.util.ArrayList<>(java.util.List.of(Files.readString(Path.of("/opt/controller-certificate.pem"))));
        launcher.workDir = new java.io.File("/work");
        launcher.run();
    }
}
