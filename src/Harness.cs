// Headless harness: construct MainForm and dump its control tree (no ShowDialog).
using System;
using System.Windows.Forms;
using ViralClips;

static class Harness
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        var f = new MainForm();
        Console.WriteLine("FORM TITLE: " + f.Text);
        Console.WriteLine("FORM SIZE: " + f.Width + "x" + f.Height);
        Dump(f.Controls, 0);
        Console.WriteLine("HARNESS OK");
    }

    static void Dump(Control.ControlCollection cc, int depth)
    {
        foreach (Control c in cc)
        {
            string pad = new string(' ', depth * 2);
            string text = (c.Text ?? "").Replace("\r", " ").Replace("\n", " ");
            if (text.Length > 70) text = text.Substring(0, 70) + "...";
            Console.WriteLine(pad + c.GetType().Name + " | Enabled=" + c.Enabled + " | Text=\"" + text + "\"");
            if (c.Controls.Count > 0) Dump(c.Controls, depth + 1);
        }
    }
}
